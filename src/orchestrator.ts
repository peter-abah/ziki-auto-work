import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentKey,
  CheckRunResult,
  Config,
  HistoryEntry,
  Idea,
  Issue,
  ProfileConfig,
  ProfilePaths,
  LoadedProfile,
  Queue,
  QueueEntry,
  RunLimitConfig,
  State,
  StopReason,
  TaskState,
  WorkFeed,
  WorkItem
} from "./types.js";
import { loadProfile, resolveParityFile, resolveRunLimits } from "./config.js";
import { createLogger, sleep, truncate } from "./log.js";
import type { Logger } from "./log.js";
import {
  acquireLock,
  releaseLock,
  loadState,
  saveState,
  writePid,
  clearPid,
  isPaused,
  isStopped,
  counterFor,
  setTask,
  taskKey,
  pruneState,
  appendHistory,
  isAlive
} from "./state.js";
import { Mutex } from "./mutex.js";
import { TaskPool } from "./scheduler.js";
import type { TaskKind } from "./scheduler.js";
import { clientForAgent, normalizeIdea, normalizeIssue } from "./ziki.js";
import type { ZikiClient } from "./ziki.js";
import { GitHub, branchName, buildPrBody, slugify } from "./github.js";
import { prepareWorktree, prepareReviewWorktree, cleanupWorktree } from "./worktree.js";
import {
  runWorker,
  runDiscovery,
  runReview,
  runConfirm,
  runTriage,
  runOwner,
  killActiveAgents,
  activeAgentPids,
  killProcessTree
} from "./agent.js";
import { loadMemoryContext, formatMemoryForPrompt, recordTaskNote } from "./memory.js";
import type { MemoryContext } from "./memory.js";
import { escalate, poll, writeNeedsHuman } from "./hitl.js";
import { buildQueue, textMatchesPlatform } from "./queue.js";
import { runChecks, scanSecrets, protectedFiles } from "./checks.js";
import { profilePaths, paths } from "./platform/paths.js";
import { issueUrl } from "./urls.js";

const WORKABLE = new Set(["requires_confirmation", "open", "in_progress"]);
const TERMINAL = new Set(["resolved", "closed"]);

interface AgentClient {
  name: string;
  key: string;
  client: ZikiClient;
}

interface Context {
  loaded: LoadedProfile;
  config: Config;
  profile: ProfileConfig;
  profileName: string;
  profilePaths: ProfilePaths;
  state: State;
  logger: Logger;
  clients: { workers: AgentClient[]; managers: AgentClient[] };
  primary: AgentClient;
  github: GitHub;
  repoReady: boolean;
  memory: MemoryContext | null;
  memoryText: string;
  feedCache: Record<string, WorkFeed>;
  feed: WorkFeed | null;
  queue: Queue | null;
  platform: { issues: Issue[]; ideas: Idea[]; fetchedAt: string | null };
  dryRun: boolean;
  pool: TaskPool;
  mutex: Mutex;
  runLimits: RunLimitConfig;
  auxThisCycle: number;
  reservedAgents: Set<string>;
  cycleStats: { deliveries: number; reviews: number; aux: number; errors: number };
}

function isOurAgent(ctx: Context, name: string | null | undefined): boolean {
  if (!name) return false;
  return [...ctx.clients.workers, ...ctx.clients.managers].some((agent) => agent.name === name);
}

function clientByName(ctx: Context, name: string | null | undefined): AgentClient | null {
  if (!name) return null;
  return [...ctx.clients.workers, ...ctx.clients.managers].find((agent) => agent.name === name) ?? null;
}

function activeClaims(ctx: Context): TaskState[] {
  return Object.values(ctx.state.tasks).filter((task) => ["claimed", "working"].includes(task.status));
}

function pickWorker(ctx: Context, exclude: string[] = []): AgentClient | null {
  const excluded = new Set(exclude.filter(Boolean));
  return (
    ctx.clients.workers.find((agent) => !excluded.has(agent.name)) ??
    ctx.clients.managers.find((agent) => !excluded.has(agent.name)) ??
    null
  );
}

function pickManager(ctx: Context, exclude: string[] = []): AgentClient | null {
  const excluded = new Set(exclude.filter(Boolean));
  return ctx.clients.managers.find((agent) => !excluded.has(agent.name)) ?? null;
}

function pickManagerOrWorker(ctx: Context, exclude: string[] = []): AgentClient | null {
  return pickManager(ctx, exclude) ?? pickWorker(ctx, exclude);
}

function pickAvailableWorker(ctx: Context): AgentClient | null {
  const busy = new Set(
    Object.values(ctx.state.tasks)
      .filter((task) => ["claimed", "working"].includes(task.status))
      .map((task) => task.agentName)
      .filter((name): name is string => Boolean(name))
  );
  const pool = ctx.clients.workers.length ? ctx.clients.workers : ctx.clients.managers;
  return pool.find((agent) => !busy.has(agent.name) && !ctx.reservedAgents.has(agent.name)) ?? null;
}

function agentHooks(ctx: Context): { onSpawn: (pid: number) => void; onExit: (pid: number) => void } {
  return {
    onSpawn: (pid: number) => {
      ctx.state.activePids = [...new Set([...ctx.state.activePids, pid])];
      void save(ctx).catch(() => {});
    },
    onExit: (pid: number) => {
      ctx.state.activePids = ctx.state.activePids.filter((value) => value !== pid);
      void save(ctx).catch(() => {});
    }
  };
}

function counter(ctx: Context) {
  return counterFor(ctx.state);
}

function markRecent(ctx: Context, key: string): void {
  ctx.state.recentFeedKeys[key] = Date.now();
}

function history(ctx: Context, entry: Omit<HistoryEntry, "at">): void {
  void appendHistory(ctx.profilePaths, { at: new Date().toISOString(), ...entry }).catch(() => {});
}

function fileEvidence(files: Array<string | { path: string; lines?: string }> | undefined): Array<{ path: string; lines?: string }> {
  return (files ?? []).map((file) => (typeof file === "string" ? { path: file } : file));
}

function normalizeCommitMessage(message: string | undefined, issue: Issue): string {
  const fallback = `fix(${issue.number}): ${issue.title}`.slice(0, 72);
  if (!message) return fallback;
  const text = String(message).split("\n")[0]!.trim();
  if (!/^(fix|feat|test|refactor|chore|docs|perf|security)\([^)]+\): \S/.test(text)) return fallback;
  return text.length > 72 ? text.slice(0, 72) : text;
}

function remainingMs(ctx: Context): number | null {
  const limits = ctx.runLimits;
  const started = ctx.state.run.startedAt ? new Date(ctx.state.run.startedAt).getTime() : Date.now();
  const deadlines: number[] = [];
  if (limits.maxRuntimeMinutes !== null) {
    deadlines.push(started + limits.maxRuntimeMinutes * 60 * 1000 - Date.now());
  }
  if (limits.stopAt) {
    const at = new Date(limits.stopAt).getTime();
    if (Number.isFinite(at)) deadlines.push(at - Date.now());
  }
  if (!deadlines.length) return null;
  return Math.max(0, Math.min(...deadlines));
}

async function buildStatus(ctx: Context, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tasks = Object.values(ctx.state.tasks);
  const open = Object.values(ctx.state.escalations).filter((escalation) => escalation.status === "open");
  const started = ctx.state.run.startedAt ? new Date(ctx.state.run.startedAt).getTime() : null;
  return {
    profile: ctx.profileName,
    pid: process.pid,
    running: extra.running ?? true,
    dryRun: Boolean(ctx.dryRun),
    paused: await isPaused(ctx.profilePaths),
    stopped: await isStopped(ctx.profilePaths),
    startedAt: ctx.state.startedAt,
    lastCycleAt: ctx.state.lastCycleAt,
    lastCycleMs: ctx.state.lastCycleMs,
    cycles: ctx.state.cycles,
    queue: ctx.queue?.counts ?? null,
    tasks: {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === "queued").length,
      claimed: tasks.filter((task) => task.status === "claimed").length,
      working: tasks.filter((task) => task.status === "working").length,
      waitingHuman: tasks.filter((task) => task.status === "waiting_human").length,
      delivered: tasks.filter((task) => task.status === "delivered").length,
      done: tasks.filter((task) => task.status === "done").length,
      failed: tasks.filter((task) => task.status === "failed").length
    },
    taskList: tasks.slice(-200).map((task) => ({
      issue: task.number,
      title: task.title,
      status: task.status,
      pr: task.prUrl ?? null,
      agent: task.agentName ?? null,
      lastError: task.lastError ?? null,
      updatedAt: task.updatedAt
    })),
    counters: counter(ctx),
    escalations: open.map((escalation) => ({
      id: escalation.id,
      issue: escalation.issueNumber,
      type: escalation.type,
      body: truncate(escalation.body, 300),
      createdAt: escalation.createdAt
    })),
    run: {
      limits: ctx.runLimits,
      startedAt: ctx.state.run.startedAt,
      elapsedMs: started ? Date.now() - started : null,
      remainingMs: remainingMs(ctx),
      remainingCycles:
        ctx.runLimits.maxCycles === null ? null : Math.max(0, ctx.runLimits.maxCycles - ctx.state.cycles),
      remainingDeliveries:
        ctx.runLimits.maxDeliveriesTotal === null
          ? null
          : Math.max(0, ctx.runLimits.maxDeliveriesTotal - ctx.state.run.deliveries),
      deliveries: ctx.state.run.deliveries,
      stopReason: ctx.state.run.stopReason
    },
    inFlight: {
      total: ctx.pool.total(),
      deliveries: ctx.pool.count("delivery"),
      reviews: ctx.pool.count("review"),
      aux: ctx.pool.count("aux"),
      discovery: ctx.pool.count("discovery"),
      owner: ctx.pool.count("owner"),
      tasks: ctx.pool.list()
    },
    lastCycle: ctx.state.lastCycle,
    memoryLoadedAt: ctx.memory?.loadedAt ?? null,
    repoReady: ctx.repoReady,
    lastError: ctx.state.lastError,
    ...extra
  };
}

async function writeStatus(ctx: Context, extra: Record<string, unknown> = {}): Promise<void> {
  const status = await buildStatus(ctx, extra);
  await ctx.mutex.run(async () => {
    await mkdir(ctx.profilePaths.stateDir, { recursive: true });
    await writeFile(ctx.profilePaths.statusFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  });
}

async function save(ctx: Context): Promise<void> {
  if (ctx.state.lastCycleAt) {
    ctx.state.lastCycle = {
      at: ctx.state.lastCycleAt,
      ms: ctx.state.lastCycleMs ?? 0,
      queue: ctx.queue?.counts ?? ctx.state.lastCycle?.queue ?? null,
      ...ctx.cycleStats
    };
  }
  await ctx.mutex.run(async () => {
    await saveState(ctx.profilePaths, ctx.state);
    const status = await buildStatus(ctx);
    await mkdir(ctx.profilePaths.stateDir, { recursive: true });
    await writeFile(ctx.profilePaths.statusFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  });
}

async function fetchMergedFeed(ctx: Context): Promise<WorkFeed | null> {
  const agents = [ctx.clients.workers[0], ctx.clients.managers[0]].filter(Boolean) as AgentClient[];
  if (!agents.length) return null;

  const merged = new Map<string, WorkItem>();
  let base: WorkFeed | null = null;

  for (const agent of agents) {
    try {
      const etag = ctx.state.feedEtags[agent.name];
      let result = await agent.client.work({ etag });
      if (result.notModified) {
        const cached = ctx.feedCache[agent.name];
        if (cached) {
          result = { notModified: false, data: cached, etag: result.etag ?? etag };
        } else {
          result = await agent.client.work({});
        }
      }
      if (!result.data) continue;
      ctx.feedCache[agent.name] = result.data;
      if (!base) base = result.data;
      for (const item of result.data.items ?? []) {
        item._feedAgent = agent.name;
        const previous = merged.get(item.key);
        if (!previous || (item.actions?.length ?? 0) > (previous.actions?.length ?? 0)) {
          merged.set(item.key, item);
        }
      }
      if (result.etag) ctx.state.feedEtags[agent.name] = result.etag;
    } catch (error) {
      ctx.logger.warn(`Work feed failed for ${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!base) return null;
  return { ...base, items: [...merged.values()] };
}

async function loadPlatformSets(ctx: Context): Promise<Context["platform"]> {
  const file = ctx.profilePaths.desktopCacheFile;
  let cached: Context["platform"] | null = null;
  if (existsSync(file)) {
    try {
      cached = JSON.parse(await readFile(file, "utf8")) as Context["platform"];
    } catch {
      cached = null;
    }
  }
  if (cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < 10 * 60 * 1000) {
    return cached;
  }
  try {
    const [issues, ideas] = await Promise.all([
      ctx.primary.client.listAllIssues({ platform: ctx.profile.ziki.platform, max: 600 }),
      ctx.primary.client.listAllIdeas({ platform: ctx.profile.ziki.platform, max: 600 })
    ]);
    const data: Context["platform"] = {
      fetchedAt: new Date().toISOString(),
      issues: issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        status: issue.status,
        substatus: issue.substatus
      })) as Issue[],
      ideas: ideas.map((idea) => ({ id: idea.id, number: idea.number, title: idea.title, status: idea.status })) as Idea[]
    };
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return data;
  } catch (error) {
    ctx.logger.warn(`Platform set refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    return cached ?? { fetchedAt: null, issues: [], ideas: [] };
  }
}

async function heartbeatPass(ctx: Context): Promise<void> {
  const now = Date.now();
  for (const task of activeClaims(ctx)) {
    if (!task.agentName || !task.id) continue;
    const last = task.lastHeartbeatAt ? new Date(task.lastHeartbeatAt).getTime() : 0;
    if (now - last < 10 * 60 * 1000) continue;
    const agent = clientByName(ctx, task.agentName);
    if (!agent) continue;
    try {
      await agent.client.heartbeat(task.id);
      task.lastHeartbeatAt = new Date().toISOString();
      ctx.logger.info(`Heartbeat #${task.number}`, { agent: agent.name });
    } catch (error) {
      ctx.logger.warn(`Heartbeat failed for #${task.number}: ${error instanceof Error ? error.message : String(error)}`);
      if ([409, 410].includes((error as { status?: number }).status ?? 0)) {
        task.status = "queued";
        task.claimId = undefined;
        task.lastError = "claim lost";
      }
    }
  }
}

async function withScratch<T>(ctx: Context, label: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(ctx.profilePaths.worktreesDir, `scratch-${slugify(label, 60)}`);
  await ctx.github.createScratchWorktree(dir);
  try {
    return await fn(dir);
  } finally {
    await cleanupWorktree(ctx.github, dir);
  }
}

async function processOwnerItem(ctx: Context, item: QueueEntry): Promise<void> {
  const requestId = String(item.key).split(":")[1] ?? "";
  const agent = clientByName(ctx, item.item._feedAgent) ?? ctx.primary;
  const request = { id: requestId, body: item.detail };
  ctx.logger.info(`Owner request ${requestId}: ${truncate(request.body, 160)}`);

  const result = await withScratch(ctx, `owner-${requestId}`, (dir) =>
    runOwner({
      profile: ctx.profile,
      profilePaths: ctx.profilePaths,
      request,
      memoryText: ctx.memoryText,
      repoDir: dir,
      logger: ctx.logger,
      ...agentHooks(ctx)
    })
  );

  if (result.ok) {
    try {
      await agent.client.completeOwnerRequest(requestId);
    } catch (error) {
      ctx.logger.warn(`Could not mark owner request ${requestId} done: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeOwnerResult(ctx, requestId, request.body, result);
    await recordTaskNote(agent.client, { id: requestId, number: "owner", title: "Owner request" }, "owner_request", result.summary, result.description, ctx.state, agent.name);
  } else {
    ctx.logger.warn(`Owner request ${requestId} failed: ${result.error ?? result.blocker ?? "unknown"}`);
  }
  markRecent(ctx, item.key);
  await save(ctx);
}

async function writeOwnerResult(ctx: Context, requestId: string, request: string, result: { ok: boolean; summary?: string; description?: string; actions?: string[] }): Promise<void> {
  const block = [
    `## ${new Date().toISOString()} · ${requestId}`,
    "",
    `Request: ${request}`,
    "",
    `Outcome: ${result.ok ? "done" : "failed"}`,
    `Summary: ${result.summary ?? ""}`,
    "",
    result.description ?? "",
    "",
    result.actions?.length ? `Next: ${result.actions.join("; ")}` : "",
    ""
  ]
    .filter(Boolean)
    .join("\n");
  const existing = existsSync(ctx.profilePaths.ownerRequestsFile) ? await readFile(ctx.profilePaths.ownerRequestsFile, "utf8") : "# Owner requests\n\n";
  await writeFile(ctx.profilePaths.ownerRequestsFile, `${existing}${block}\n`, "utf8");
}

async function processWorkItem(ctx: Context, item: QueueEntry, preferredWorker?: AgentClient): Promise<void> {
  const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
  const issue = normalizeIssue(data);
  if (!issue) return;

  const existingTask = ctx.state.tasks[taskKey(issue)] ?? null;
  const terminalStatus =
    TERMINAL.has(issue.status) || ["done", "merge", "accepted"].includes(issue.status) || ["done", "merge"].includes(issue.substatus);

  if (issue.pullRequestUrl) {
    if (issue.holder && issue.holder.status === "active" && !isOurAgent(ctx, issue.holder.agentName)) {
      markRecent(ctx, item.key);
      return;
    }
    const ours = Boolean(existingTask?.prUrl) || isOurAgent(ctx, issue.holder?.agentName);
    if (terminalStatus) {
      if (ours) {
        setTask(ctx.state, issue, {
          status: "delivered",
          prUrl: issue.pullRequestUrl,
          reason: `issue is ${issue.status}/${issue.substatus}`
        });
      } else {
        setTask(ctx.state, issue, { status: "skipped", reason: `issue is ${issue.status}` });
      }
      markRecent(ctx, item.key);
      await save(ctx);
      return;
    }
    if (existingTask && ["delivered", "done"].includes(existingTask.status)) {
      markRecent(ctx, item.key);
      return;
    }
    if (ours) {
      const recovered = await recoverDelivery(ctx, issue);
      markRecent(ctx, item.key);
      if (recovered) await save(ctx);
      return;
    }
    ctx.logger.debug(`#${issue.number} already has PR ${issue.pullRequestUrl}; skipping`);
    markRecent(ctx, item.key);
    return;
  }

  if (terminalStatus) {
    setTask(ctx.state, issue, { status: "skipped", reason: `issue is ${issue.status}` });
    markRecent(ctx, item.key);
    return;
  }
  if (issue.platform?.slug && issue.platform.slug !== ctx.profile.ziki.platform) {
    markRecent(ctx, item.key);
    return;
  }
  if (issue.holder && issue.holder.status === "active" && !isOurAgent(ctx, issue.holder.agentName)) {
    ctx.logger.debug(`#${issue.number} held by ${issue.holder.agentName}; skipping`);
    markRecent(ctx, item.key);
    return;
  }
  if (!WORKABLE.has(issue.substatus) && !WORKABLE.has(issue.status)) {
    markRecent(ctx, item.key);
    return;
  }

  if (!(await ensureReady(ctx, issue))) {
    markRecent(ctx, item.key);
    return;
  }
  const claim = await ensureClaim(ctx, issue, preferredWorker);
  if (!claim) {
    markRecent(ctx, item.key);
    return;
  }

  const worker = claim.agent;
  const branch = branchName(issue, issue.title);
  const dir = await prepareWorktree(ctx.github, ctx.profilePaths, issue, branch);
  setTask(ctx.state, issue, {
    status: "working",
    agentName: worker.name,
    branch,
    worktree: dir,
    lastHeartbeatAt: new Date().toISOString(),
    attempts: (ctx.state.tasks[taskKey(issue)]?.attempts ?? 0) + 1
  });
  await save(ctx);

  const comments = (issue.comments ?? [])
    .slice(-10)
    .map((comment) => `- ${comment.authorName ?? comment.by ?? "someone"}: ${comment.body}`)
    .join("\n");
  const issueContext =
    [issue.pullRequestUrl ? `Linked PR: ${issue.pullRequestUrl}` : "", comments ? `Recent comments:\n${comments}` : ""]
      .filter(Boolean)
      .join("\n\n") || "(none)";

  const heartbeat = setInterval(() => {
    worker.client.heartbeat(issue.id).catch(() => {});
  }, 10 * 60 * 1000);

  let result;
  try {
    result = await runWorker({
      profile: ctx.profile,
      profilePaths: ctx.profilePaths,
      issue,
      memoryText: ctx.memoryText,
      worktree: dir,
      branch,
      base: ctx.profile.repo.base,
      previousError: ctx.state.tasks[taskKey(issue)]?.lastError ?? "",
      issueContext,
      logger: ctx.logger,
      ...agentHooks(ctx)
    });
  } finally {
    clearInterval(heartbeat);
  }

  if (!result.ok) {
    await handleWorkFailure(ctx, issue, item, result, worker, dir);
    return;
  }

  await ctx.github.git(["add", "-A"], { cwd: dir });
  const changed = await ctx.github.stagedChangedFiles(dir);
  if (!changed.length) return handleWorkFailure(ctx, issue, item, { error: "agent made no changes" }, worker, dir);
  if (changed.length > 5) {
    return handleWorkFailure(ctx, issue, item, { error: `change touches ${changed.length} files (max 5)` }, worker, dir);
  }
  const protectedHits = protectedFiles(changed, ctx.profile.repo.protectedFiles);
  if (protectedHits.length) {
    return handleWorkFailure(ctx, issue, item, { error: `protected files changed: ${protectedHits.join(", ")}` }, worker, dir);
  }

  const diff = await ctx.github
    .git(["diff", "--cached", `upstream/${ctx.profile.repo.base}`], { cwd: dir })
    .then((output) => output.stdout)
    .catch(() => "");
  const secretHits = scanSecrets(diff);
  if (secretHits.length) {
    return handleWorkFailure(ctx, issue, item, { error: `possible secret in diff: ${secretHits[0]}` }, worker, dir);
  }

  const checks = await runChecks(ctx.profile, dir, {
    changedFiles: changed,
    baselineFailures: ctx.state.baselineFailures,
    logger: ctx.logger
  });
  if (!checks.ok) {
    ctx.logger.warn("Checks failed", {
      issue: issue.number,
      results: checks.results.map((check) => ({ name: check.name, ok: check.ok, output: check.output }))
    });
    return handleWorkFailure(ctx, issue, item, { error: "checks failed" }, worker, dir);
  }

  const message = normalizeCommitMessage(result.commitMessage, issue);
  const commit = await ctx.github.commitAll(dir, message);
  if (!commit.committed) {
    return handleWorkFailure(ctx, issue, item, { error: "nothing to commit" }, worker, dir);
  }

  await ctx.github.pushBranch(dir, branch);
  const body = await buildPrBody(ctx.profile, {
    issue,
    summary: result.summary ?? `Fix #${issue.number}`,
    description: result.description ?? "",
    testResults: result.testResults ?? checks.results.map((check) => `${check.name}: ${check.ok ? "pass" : "fail"}`).join("\n"),
    testedAgainst: result.testedAgainst,
    howToTest: result.howToTest,
    whatToExpect: result.whatToExpect,
    screenshots: (result.screenshots ?? []).filter((screenshot) => /^https?:\/\//.test(screenshot)),
    checks: checks.results.map((check) => `${check.name}: ${check.ok ? "pass" : "fail"}`),
    risks: result.risks,
    notes: result.notes
  });
  const pr = await ctx.github.createPr(branch, message, body);
  const headSha = await ctx.github.headSha(dir);

  await worker.client.deliver(issue.id, {
    pullRequestUrl: pr.url,
    summary: result.summary ?? `Fix #${issue.number}`,
    description: result.description ?? result.summary ?? "",
    testResults: result.testResults ?? checks.results.map((check) => `${check.name}: ${check.ok ? "pass" : "fail"}`).join("\n"),
    headSha
  });

  setTask(ctx.state, issue, {
    status: "delivered",
    agentName: worker.name,
    branch,
    worktree: dir,
    prUrl: pr.url,
    headSha,
    deliveredAt: new Date().toISOString(),
    lastError: null
  } as Partial<TaskState>);
  counter(ctx).deliveries += 1;
  ctx.state.run.deliveries += 1;
  ctx.cycleStats.deliveries += 1;
  history(ctx, { type: "delivery", issue: issue.number, detail: worker.name, data: { pr: pr.url, branch, files: changed.length } });
  markRecent(ctx, item.key);
  await recordTaskNote(worker.client, ctx.state.tasks[taskKey(issue)]!, "delivered", result.summary, result.description, ctx.state, worker.name);
  ctx.logger.info(`Delivered #${issue.number}`, { pr: pr.url, branch, files: changed.length });
  await save(ctx);
}

async function recoverDelivery(ctx: Context, issue: Issue): Promise<boolean> {
  if (!issue.pullRequestUrl) return false;
  const agent = (issue.holder?.agentName ? clientByName(ctx, issue.holder.agentName) : null) ?? pickWorker(ctx);
  if (!agent) return false;
  let status: Awaited<ReturnType<GitHub["prStatus"]>> | null = null;
  try {
    status = await ctx.github.prStatus(issue.pullRequestUrl);
  } catch (error) {
    ctx.logger.warn(`Could not verify PR for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (status && (status.checks === "failing" || status.mergeable === false)) {
    ctx.logger.warn(`PR for #${issue.number} is not deliverable yet (checks=${status.checks}, mergeable=${String(status.mergeable)})`);
    return false;
  }
  try {
    await agent.client.deliver(issue.id, {
      pullRequestUrl: issue.pullRequestUrl,
      summary: `Fix #${issue.number}: ${issue.title}`,
      description: "Recovered delivery after a restart: the PR already exists.",
      testResults: status ? `PR checks: ${status.checks}` : undefined,
      headSha: status?.headSha ?? issue.pullRequestHeadSha ?? undefined
    });
  } catch (error) {
    ctx.logger.warn(`Recovered delivery failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  setTask(ctx.state, issue, {
    status: "delivered",
    agentName: agent.name,
    prUrl: issue.pullRequestUrl,
    headSha: status?.headSha ?? issue.pullRequestHeadSha ?? undefined,
    deliveredAt: new Date().toISOString(),
    lastError: null
  });
  counter(ctx).deliveries += 1;
  ctx.state.run.deliveries += 1;
  ctx.cycleStats.deliveries += 1;
  history(ctx, { type: "delivery", issue: issue.number, detail: "recovered existing PR", data: { pr: issue.pullRequestUrl } });
  ctx.logger.info(`Recovered delivery for #${issue.number}`, { pr: issue.pullRequestUrl });
  return true;
}

async function handleWorkFailure(
  ctx: Context,
  issue: Issue,
  item: QueueEntry,
  result: { error?: string; blocked?: boolean; blocker?: string | null; summary?: string; tail?: string },
  worker: AgentClient,
  dir: string
): Promise<void> {
  const task = ctx.state.tasks[taskKey(issue)];
  const attempts = (task?.attempts ?? 0) + 1;
  const maxAttempts = ctx.profile.limits.maxAttemptsPerTask;
  const error = result.error ?? result.blocker ?? "unknown failure";
  ctx.logger.warn(`#${issue.number} attempt ${attempts} failed: ${truncate(error, 300)}`);
  ctx.state.lastError = { at: new Date().toISOString(), issue: issue.number, error: truncate(error, 500) };
  history(ctx, { type: "failure", issue: issue.number, detail: truncate(error, 300), data: { attempts } });

  await cleanupWorktree(ctx.github, dir);

  if (result.blocked) {
    const escalation = await escalate(worker.client, ctx.profile, ctx.profilePaths, ctx.state, {
      issue,
      type: "blocker",
      body: `#${issue.number} needs a human: ${result.blocker ?? result.summary ?? error}`,
      agentName: worker.name,
      logger: ctx.logger,
      notifyCommand: ctx.profile.hitl.notifyCommand,
      maxOpen: ctx.profile.limits.maxOpenEscalations
    });
    if (escalation.ok) history(ctx, { type: "escalation", issue: issue.number, detail: "blocker", data: { id: escalation.escalation?.id } });
    if (!escalation.ok && !escalation.skipped) {
      setTask(ctx.state, issue, { status: "queued", attempts, lastError: error, worktree: undefined });
    }
  } else if (attempts >= maxAttempts) {
    setTask(ctx.state, issue, { status: "failed", attempts, lastError: error, worktree: undefined });
    await worker.client.release(issue.id).catch(() => {});
    await recordTaskNote(worker.client, issue, "failed", error, result.tail ?? "", ctx.state, worker.name);
  } else {
    setTask(ctx.state, issue, { status: "queued", attempts, lastError: error, worktree: undefined });
  }
  markRecent(ctx, item.key);
  await save(ctx);
}

async function ensureReady(ctx: Context, issue: Issue): Promise<boolean> {
  if (issue.substatus === "requires_confirmation") {
    const confirmer = pickManagerOrWorker(ctx);
    if (!confirmer) return false;
    const result = await withScratch(ctx, `confirm-${issue.number}`, (dir) =>
      runConfirm({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        memoryText: ctx.memoryText,
        repoDir: dir,
        logger: ctx.logger,
        ...agentHooks(ctx)
      })
    );
    if (!result.ok) {
      if (result.blocked) {
        const escalation = await escalate(confirmer.client, ctx.profile, ctx.profilePaths, ctx.state, {
          issue,
          type: "blocker",
          body: `Cannot confirm #${issue.number}: ${result.blocker ?? result.summary ?? result.error ?? "unknown"}`,
          agentName: confirmer.name,
          logger: ctx.logger,
          notifyCommand: ctx.profile.hitl.notifyCommand,
          maxOpen: ctx.profile.limits.maxOpenEscalations
        });
        if (escalation.ok) history(ctx, { type: "escalation", issue: issue.number, detail: "confirmation blocker" });
      }
      return false;
    }
    if (result.verdict !== "confirm") {
      setTask(ctx.state, issue, { status: "skipped", reason: `confirmation verdict: ${result.verdict ?? "unknown"}` });
      await save(ctx);
      return false;
    }
    const confirmation = await confirmer.client.confirmIssue(issue.id, {
      verdict: "confirm",
      summary: result.summary ?? `Confirmed #${issue.number}`,
      description: result.description ?? "",
      files: fileEvidence(result.files),
      duplicateOfId: result.duplicateOfId ?? undefined
    });
    if (confirmation?.confirmed) {
      await confirmer.client.openIssue(issue.id).catch(() => {});
      return true;
    }
    ctx.logger.info(`Confirmation for #${issue.number} still needs weight; not spinning this cycle`);
    markRecent(ctx, `confirm:${issue.id}`);
    return false;
  }

  if (issue.status === "open" || issue.substatus === "open") return true;
  return issue.status === "in_progress" || issue.substatus === "in_progress";
}

async function ensureBidAndAward(
  ctx: Context,
  issue: Issue,
  preferred?: AgentClient
): Promise<{ agent: AgentClient; claimId: string } | null> {
  const worker = preferred ?? pickWorker(ctx);
  if (!worker) return null;
  const awarder = pickManager(ctx) ?? worker;

  let bids: any[] = [];
  try {
    const data = await worker.client.listBids(issue.id);
    bids = data.bids ?? data.items ?? [];
  } catch {
    bids = [];
  }

  let bidId: string | null = bids.find((bid) => bid.agent_name === worker.name)?.id ?? null;
  if (!bidId) {
    const summary = `I can fix #${issue.number}: ${truncate(issue.title, 120)}`;
    const description = [
      `Plan: reproduce the issue in ${ctx.profile.ziki.platform}, make the smallest scoped fix, add a regression test, run the configured checks, and deliver a PR with evidence.`,
      "",
      `Ticket: #${issue.number} ${issue.title}`,
      issue.summary ? `Reported: ${issue.summary}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    const created = await worker.client.bid(issue.id, { summary, description });
    bidId = created.bid_id ?? created.id ?? created.bidId ?? null;
    if (bidId) history(ctx, { type: "bid", issue: issue.number, detail: worker.name, data: { bidId } });
  }
  if (!bidId) return null;

  let award;
  try {
    award = await awarder.client.awardBid(bidId);
    history(ctx, {
      type: "award",
      issue: issue.number,
      detail: `${awarder.name}${awarder.name === worker.name ? " (self)" : ""}`,
      data: { bidId }
    });
  } catch (error) {
    ctx.logger.warn(`Award failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const claimId = award.claimId ?? award.claim_id;
  if (!claimId) return null;

  try {
    await worker.client.acceptOffer(claimId);
    history(ctx, { type: "accept", issue: issue.number, detail: worker.name, data: { claimId } });
  } catch (error) {
    ctx.logger.warn(`Offer accept failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  setTask(ctx.state, issue, {
    status: "claimed",
    agentName: worker.name,
    claimId,
    lastHeartbeatAt: new Date().toISOString()
  });
  history(ctx, { type: "claim", issue: issue.number, detail: worker.name, data: { claimId } });
  await save(ctx);
  return { agent: worker, claimId };
}

async function ensureClaim(
  ctx: Context,
  issue: Issue,
  preferred?: AgentClient
): Promise<{ agent: AgentClient; claimId: string } | null> {
  const holder = issue.holder;
  if (holder) {
    const agent = clientByName(ctx, holder.agentName);
    if (!agent) return null;
    if (holder.status === "active") {
      setTask(ctx.state, issue, { status: "claimed", agentName: agent.name, claimId: holder.id, lastHeartbeatAt: new Date().toISOString() });
      history(ctx, { type: "claim", issue: issue.number, detail: `${agent.name} (existing)`, data: { claimId: holder.id } });
      return { agent, claimId: holder.id };
    }
    if (holder.status === "offered") {
      try {
        await agent.client.acceptOffer(holder.id);
        setTask(ctx.state, issue, { status: "claimed", agentName: agent.name, claimId: holder.id, lastHeartbeatAt: new Date().toISOString() });
        history(ctx, { type: "accept", issue: issue.number, detail: agent.name, data: { claimId: holder.id } });
        return { agent, claimId: holder.id };
      } catch (error) {
        ctx.logger.warn(`Could not accept existing offer for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
  }
  return ensureBidAndAward(ctx, issue, preferred);
}

async function processTestFix(ctx: Context, item: QueueEntry): Promise<void> {
  const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
  const issue = normalizeIssue(data);
  if (!issue?.pullRequestUrl) {
    markRecent(ctx, item.key);
    return;
  }
  const match = issue.pullRequestUrl.match(/\/pull\/(\d+)/);
  const prNumber = match ? Number(match[1]) : null;
  if (!prNumber) {
    markRecent(ctx, item.key);
    return;
  }
  const holder = issue.holder?.agentName ?? null;
  const reviewer = pickWorker(ctx, [holder ?? ""]) ?? pickManager(ctx, [holder ?? ""]);
  if (!reviewer) {
    markRecent(ctx, item.key);
    return;
  }

  const dir = await prepareReviewWorktree(ctx.github, ctx.profilePaths, prNumber);
  let result;
  try {
    result = await runReview({
      profile: ctx.profile,
      profilePaths: ctx.profilePaths,
      issue,
      memoryText: ctx.memoryText,
      worktree: dir,
      prUrl: issue.pullRequestUrl,
      headSha: issue.pullRequestHeadSha ?? "",
      logger: ctx.logger,
      ...agentHooks(ctx)
    });
  } finally {
    await cleanupWorktree(ctx.github, dir);
  }

  if (!result.ok) {
    ctx.logger.warn(`Review of #${issue.number} failed: ${result.error ?? result.blocker ?? "unknown"}`);
    markRecent(ctx, item.key);
    return;
  }

  await reviewer.client.submitTestResult(issue.id, {
    goodToMerge: result.goodToMerge === true,
    summary: result.summary ?? (result.goodToMerge ? "Good to merge." : "Not good to merge."),
    description: result.description ?? "",
    files: fileEvidence(result.files),
    headSha: result.headSha ?? issue.pullRequestHeadSha ?? undefined
  });
  counter(ctx).reviews += 1;
  ctx.cycleStats.reviews += 1;
  history(ctx, {
    type: "review",
    issue: issue.number,
    detail: reviewer.name,
    data: { goodToMerge: result.goodToMerge === true }
  });
  markRecent(ctx, item.key);
  await recordTaskNote(reviewer.client, issue, "reviewed", result.summary, result.description, ctx.state, reviewer.name);
  ctx.logger.info(`Reviewed #${issue.number}`, { goodToMerge: result.goodToMerge, reviewer: reviewer.name });
  await save(ctx);
}

async function processAccept(ctx: Context, item: QueueEntry): Promise<void> {
  const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
  const issue = normalizeIssue(data);
  if (!issue) {
    markRecent(ctx, item.key);
    return;
  }
  const holder = issue.holder?.agentName ?? null;
  const manager = pickManager(ctx, [holder ?? ""]);
  if (!manager) {
    ctx.logger.debug(`Skipping merge review for #${issue.number}: no manager/merger agent configured`);
    markRecent(ctx, item.key);
    return;
  }

  let good = false;
  try {
    const tests = await manager.client.listTestResults(issue.id);
    good = (tests.verdicts ?? []).some((verdict) => verdict.goodToMerge === true && verdict.current !== false);
  } catch {
    good = false;
  }

  let prStatus = null;
  if (issue.pullRequestUrl) {
    try {
      prStatus = await ctx.github.prStatus(issue.pullRequestUrl);
    } catch (error) {
      ctx.logger.warn(`PR status failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!good || !prStatus || prStatus.checks === "failing" || prStatus.mergeable === false) {
    if (prStatus && issue.pullRequestUrl) {
      const reporter = pickManager(ctx, [holder ?? ""]) ?? pickWorker(ctx, [holder ?? ""]);
      if (reporter) await reportPrStatusWith(ctx, reporter, issue, prStatus).catch(() => {});
    }
    markRecent(ctx, item.key);
    return;
  }

  await manager.client.mergeReview(issue.id, {
    verdict: "accept",
    summary: "Accept: tested and green.",
    description: `Reviewed #${issue.number}. Test verdicts are good to merge; PR ${issue.pullRequestUrl} reports checks ${prStatus.checks} and mergeable ${String(prStatus.mergeable)}.`
  });
  counter(ctx).reviews += 1;
  ctx.cycleStats.reviews += 1;
  history(ctx, { type: "merge_review", issue: issue.number, detail: manager.name, data: { verdict: "accept" } });
  markRecent(ctx, item.key);
  ctx.logger.info(`Accepted #${issue.number}`, { manager: manager.name });
  await save(ctx);
}

async function processAuxItem(ctx: Context, item: QueueEntry): Promise<boolean> {
  if (item.item.canAct === false) {
    markRecent(ctx, item.key);
    return false;
  }
  try {
    let did = false;
    switch (item.kind) {
      case "report_pr_status":
        did = await processPrReport(ctx, item);
        break;
      case "review_bid":
        did = await processBidVote(ctx, item);
        break;
      case "award_bid":
        did = await processAward(ctx, item);
        break;
      case "review_comment":
        did = await processCommentUpvote(ctx, item);
        break;
      case "categorize":
        did = await processCategorize(ctx, item);
        break;
      case "idea":
        did = await processIdeaVerdict(ctx, item);
        break;
      case "confirm_issue":
        did = await processConfirm(ctx, item);
        break;
      default:
        ctx.logger.debug(`Unhandled aux kind "${item.kind}"; marking recent`);
        markRecent(ctx, item.key);
        did = false;
    }
    if (did) {
      counter(ctx).aux += 1;
      ctx.cycleStats.aux += 1;
      history(ctx, { type: "aux", issue: item.issueNumber, idea: item.ideaNumber, detail: item.kind });
    }
    return did;
  } catch (error) {
    ctx.logger.warn(`Aux ${item.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
    counter(ctx).errors += 1;
    ctx.cycleStats.errors += 1;
    markRecent(ctx, item.key);
    return false;
  }
}

async function processPrReport(ctx: Context, item: QueueEntry): Promise<boolean> {
  const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
  const issue = normalizeIssue(data);
  if (!issue?.pullRequestUrl) {
    markRecent(ctx, item.key);
    return false;
  }
  const holder = issue.holder?.agentName ?? null;
  const reporter = pickManager(ctx, [holder ?? ""]) ?? pickWorker(ctx, [holder ?? ""]);
  if (!reporter) {
    markRecent(ctx, item.key);
    return false;
  }
  let status;
  try {
    status = await ctx.github.prStatus(issue.pullRequestUrl);
  } catch (error) {
    ctx.logger.warn(`PR status failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    markRecent(ctx, item.key);
    return false;
  }
  await reportPrStatusWith(ctx, reporter, issue, status);
  markRecent(ctx, item.key);
  return true;
}

async function reportPrStatusWith(
  ctx: Context,
  reporter: AgentClient,
  issue: Issue,
  status: Awaited<ReturnType<GitHub["prStatus"]>>
): Promise<void> {
  const report: Record<string, unknown> = {
    pullRequestUrl: issue.pullRequestUrl,
    state: status.merged ? "merged" : status.state === "CLOSED" ? "closed" : status.state === "OPEN" ? "open" : "not_found",
    headSha: status.headSha ?? undefined,
    checks: status.checks,
    mergeable: status.mergeable === null ? undefined : status.mergeable,
    note: `Checked with gh pr view: state=${status.state}, checks=${status.checks}, mergeable=${String(status.mergeable)}.`
  };
  if (status.merged) {
    report.mergedInto = status.mergedInto ?? undefined;
    report.mergeCommitSha = status.mergeCommitSha ?? undefined;
    report.inDefaultBranch = await isInDefaultBranch(ctx, status.mergeCommitSha);
  }
  await reporter.client.reportPrStatus(issue.id, report);
  ctx.logger.info(`Reported PR state for #${issue.number}`, { state: report.state, reporter: reporter.name });
}

async function isInDefaultBranch(ctx: Context, sha: string | null): Promise<boolean> {
  if (!sha) return false;
  try {
    await ctx.github.git(["fetch", "upstream", ctx.profile.repo.defaultBranch]);
    const result = await ctx.github.git(["merge-base", "--is-ancestor", sha, `upstream/${ctx.profile.repo.defaultBranch}`]);
    return result.ok;
  } catch {
    return false;
  }
}

async function processBidVote(ctx: Context, item: QueueEntry): Promise<boolean> {
  const bidId = (item.actions.find((action) => action.name === "vote_bid")?.path ?? "").match(/bids\/([^/]+)\/votes/)?.[1];
  if (!bidId) {
    markRecent(ctx, item.key);
    return false;
  }
  if (item.detail.length < 40 || !/fix|implement|add|update|test|change/i.test(item.detail)) {
    markRecent(ctx, item.key);
    return false;
  }
  const voter = pickManager(ctx) ?? pickWorker(ctx);
  if (!voter) return false;
  await voter.client.voteBid(bidId);
  markRecent(ctx, item.key);
  return true;
}

async function processAward(ctx: Context, item: QueueEntry): Promise<boolean> {
  const bidId = (item.actions.find((action) => action.name === "award_bid")?.path ?? "").match(/bids\/([^/]+)\/award/)?.[1];
  if (!bidId) {
    markRecent(ctx, item.key);
    return false;
  }
  const task = item.issueId ? ctx.state.tasks[item.issueId] : null;
  if (task && ["claimed", "working", "delivered"].includes(task.status)) {
    markRecent(ctx, item.key);
    return false;
  }
  const manager = pickManager(ctx) ?? pickWorker(ctx);
  if (!manager) return false;
  try {
    await manager.client.awardBid(bidId);
  } catch (error) {
    ctx.logger.debug(`Award skipped for #${item.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
    markRecent(ctx, item.key);
    return false;
  }
  markRecent(ctx, item.key);
  return true;
}

async function processCommentUpvote(ctx: Context, item: QueueEntry): Promise<boolean> {
  const commentId = (item.actions.find((action) => action.name === "upvote_comment")?.path ?? "").match(/comments\/([^/]+)\/votes/)?.[1];
  if (!commentId) {
    markRecent(ctx, item.key);
    return false;
  }
  if (!/root cause|\b[\w./-]+\.(dart|ts|tsx|js|jsx|py|go|rs):\d+/.test(item.detail)) {
    markRecent(ctx, item.key);
    return false;
  }
  const voter = pickWorker(ctx) ?? pickManager(ctx);
  if (!voter) return false;
  await voter.client.upvoteComment(commentId);
  markRecent(ctx, item.key);
  return true;
}

async function processCategorize(ctx: Context, item: QueueEntry): Promise<boolean> {
  const actor = pickWorker(ctx) ?? pickManager(ctx);
  if (!actor) return false;
  let did = 0;
  try {
    const issues = await actor.client.listAllIssues({ platform: "none", max: 100 });
    for (const issue of issues) {
      if (did >= 5) break;
      if (!textMatchesPlatform(ctx.profile, `${issue.title} ${issue.summary ?? ""}`)) continue;
      await actor.client.categorizeIssue(issue.id, {
        platform: ctx.profile.ziki.platform,
        reason: "Title/summary matches this profile's platform."
      });
      did += 1;
    }
    const ideas = await actor.client.listAllIdeas({ platform: "none", max: 100 });
    for (const idea of ideas) {
      if (did >= 5) break;
      if (!textMatchesPlatform(ctx.profile, `${idea.title} ${idea.summary ?? ""}`)) continue;
      await actor.client.categorizeIdea(idea.id, {
        platform: ctx.profile.ziki.platform,
        reason: "Title/summary matches this profile's platform."
      });
      did += 1;
    }
  } catch (error) {
    ctx.logger.warn(`Categorize failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  markRecent(ctx, item.key);
  if (did) history(ctx, { type: "aux", detail: "categorize", data: { count: did, by: actor.name } });
  return did > 0;
}

async function processIdeaVerdict(ctx: Context, item: QueueEntry): Promise<boolean> {
  const data = await ctx.primary.client.getIdea(item.ideaId ?? item.ideaNumber ?? "");
  const idea = normalizeIdea(data);
  if (!idea) {
    markRecent(ctx, item.key);
    return false;
  }
  const manager = pickManager(ctx);
  const voter = manager ?? pickWorker(ctx);
  if (!voter) {
    markRecent(ctx, item.key);
    return false;
  }
  const result = await withScratch(ctx, `triage-${idea.number}`, (dir) =>
    runTriage({
      profile: ctx.profile,
      profilePaths: ctx.profilePaths,
      idea,
      memoryText: ctx.memoryText,
      repoDir: dir,
      logger: ctx.logger,
      ...agentHooks(ctx)
    })
  );
  if (!result.ok) {
    markRecent(ctx, item.key);
    return false;
  }
  const opinion = result.opinion && ["good", "bad", "neutral"].includes(result.opinion) ? result.opinion : "neutral";
  const requestedVotes = opinion === "good" ? (manager ? 3 : 1) : 1;
  const verdictPayload = {
    opinion,
    votes: requestedVotes,
    summary: result.summary ?? `Triage: ${opinion}`,
    description: result.description ?? ""
  };
  try {
    await voter.client.giveIdeaVerdict(idea.id, verdictPayload);
  } catch (error) {
    if ((error as { status?: number }).status === 422 && requestedVotes > 1) {
      await voter.client.giveIdeaVerdict(idea.id, { ...verdictPayload, votes: 1 });
    } else {
      throw error;
    }
  }
  history(ctx, { type: "aux", idea: idea.number, detail: `idea verdict: ${opinion}`, data: { votes: requestedVotes } });
  if (opinion === "good") {
    try {
      const verdicts = await voter.client.ideaVerdicts(idea.id);
      if (verdicts?.convertible) {
        await voter.client.convertIdea(idea.id);
        ctx.logger.info(`Converted idea #${idea.number} after triage`);
      }
    } catch {
      // conversion is best-effort
    }
  }
  markRecent(ctx, item.key);
  return true;
}

async function processConfirm(ctx: Context, item: QueueEntry): Promise<boolean> {
  const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
  const issue = normalizeIssue(data);
  if (!issue || issue.substatus !== "requires_confirmation") {
    markRecent(ctx, item.key);
    return false;
  }
  const confirmer = pickManagerOrWorker(ctx);
  if (!confirmer) return false;
  const result = await withScratch(ctx, `confirm-aux-${issue.number}`, (dir) =>
    runConfirm({
      profile: ctx.profile,
      profilePaths: ctx.profilePaths,
      issue,
      memoryText: ctx.memoryText,
      repoDir: dir,
      logger: ctx.logger,
      ...agentHooks(ctx)
    })
  );
  if (!result.ok) {
    markRecent(ctx, item.key);
    return false;
  }
  const verdict = result.verdict && ["confirm", "reject", "neutral"].includes(result.verdict) ? result.verdict : "neutral";
  const response = await confirmer.client.confirmIssue(issue.id, {
    verdict,
    summary: result.summary ?? `Confirmation: ${verdict}`,
    description: result.description ?? "",
    files: fileEvidence(result.files),
    duplicateOfId: result.duplicateOfId ?? undefined
  });
  if (response?.confirmed) await confirmer.client.openIssue(issue.id).catch(() => {});
  history(ctx, { type: "aux", issue: issue.number, detail: `confirmation: ${verdict}`, data: { by: confirmer.name } });
  markRecent(ctx, item.key);
  return true;
}

async function discoveryPass(ctx: Context): Promise<void> {
  if (!ctx.profile.discovery.enabled) return;
  if (counter(ctx).discoveries >= ctx.profile.limits.maxDiscoveriesPerDay) return;
  const every = ctx.profile.discovery.maxCyclesBeforeRun ?? ctx.profile.limits.maxCyclesBeforeDiscovery;
  if (ctx.state.cycles % every !== 0) return;

  const existing = (ctx.platform.issues ?? [])
    .filter((issue) => ["open", "in_progress", "done", "merge"].includes(issue.status))
    .slice(0, 60)
    .map((issue) => `#${issue.number} ${issue.title}`)
    .join("\n");

  const parityFile = resolveParityFile(ctx.profile);
  const parity = parityFile && existsSync(parityFile) ? await readFile(parityFile, "utf8") : "(no parity map yet)";

  const result = await withScratch(ctx, "discovery", (dir) =>
    runDiscovery({
      profile: ctx.profile,
      profilePaths: ctx.profilePaths,
      memoryText: ctx.memoryText,
      repoDir: dir,
      parity,
      existingIssues: existing,
      maxIdeas: ctx.profile.discovery.maxIdeasPerRun ?? 3,
      logger: ctx.logger,
      ...agentHooks(ctx)
    })
  );

  if (!result.ok) {
    ctx.logger.warn(`Discovery failed: ${result.error ?? result.blocker ?? "unknown"}`);
    return;
  }
  const ideas = (result.ideas ?? []).slice(0, ctx.profile.discovery.maxIdeasPerRun ?? 3);
  for (const idea of ideas) {
    if (!idea?.title || !idea?.description) continue;
    try {
      let summary = idea.summary || idea.title;
      if (summary.length < 20) summary = `${summary} — platform parity gap.`;
      const created = await ctx.primary.client.createIdea({
        title: idea.title.slice(0, 200),
        summary: summary.slice(0, 300),
        description: idea.description.slice(0, 5000),
        platform: ctx.profile.ziki.platform,
        idempotencyKey: `aw-${ctx.profileName}-${new Date().toISOString().slice(0, 10)}-${slugify(idea.title, 50)}`,
        acknowledgeSimilar: false
      });
      const createdIdea = normalizeIdea(created);
      counter(ctx).discoveries += 1;
      ctx.logger.info(`Filed idea #${createdIdea?.number ?? "?"}: ${idea.title}`);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) {
        ctx.logger.info(`Idea skipped as similar: ${idea.title}`);
      } else {
        ctx.logger.warn(`Could not file idea "${idea.title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (ideas.length) {
    history(ctx, { type: "discovery", detail: `filed ${ideas.length} idea(s)`, data: { ideas: ideas.map((idea) => idea.title) } });
    await recordTaskNote(ctx.primary.client, { id: "discovery", number: "discovery", title: "Discovery" }, "discovery", `Filed ${ideas.length} idea(s)`, ideas.map((idea) => `- ${idea.title}`).join("\n"), ctx.state, ctx.primary.name);
  }
  await save(ctx);
}

async function ensureBaseline(ctx: Context): Promise<void> {
  const baselineChecks = ctx.profile.checks.filter((check) => check.baseline);
  if (!baselineChecks.length) return;
  const sha = await ctx.github.baseSha().catch(() => null);
  if (ctx.state.baselineSha === sha && ctx.state.baselineAt) return;

  const dir = path.join(ctx.profilePaths.worktreesDir, "scratch-baseline");
  await ctx.github.createScratchWorktree(dir);
  try {
    const changedFiles = ctx.profile.repo.baselineFile ? [ctx.profile.repo.baselineFile] : [];
    const checks = await runChecks(ctx.profile, dir, { changedFiles, baselineFailures: {}, logger: ctx.logger });
    for (const check of checks.results) {
      if (!baselineChecks.some((spec) => spec.name === check.name)) continue;
      const failures = check.failures ?? [];
      const unparsed = failures.some((failure) => failure.includes("unparsed"));
      ctx.state.baselineFailures[check.name] = unparsed ? [] : failures;
      if (unparsed) ctx.logger.warn(`Baseline check "${check.name}" failed without parsable failures; not baselining`);
    }
    ctx.state.baselineSha = sha;
    ctx.state.baselineAt = new Date().toISOString();
    ctx.logger.info("Baseline captured", { sha: sha?.slice(0, 12), checks: Object.keys(ctx.state.baselineFailures) });
  } finally {
    await cleanupWorktree(ctx.github, dir);
  }
}

async function cleanupOldWorktrees(ctx: Context): Promise<void> {
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  for (const task of Object.values(ctx.state.tasks)) {
    if (!task.worktree) continue;
    if (!["done", "failed", "skipped"].includes(task.status)) continue;
    if (new Date(task.updatedAt).getTime() > cutoff) continue;
    await cleanupWorktree(ctx.github, task.worktree);
    task.worktree = undefined;
    ctx.logger.info(`Cleaned worktree for #${task.number}`);
  }
}

async function runCycle(ctx: Context): Promise<{ ok?: boolean; dryRun?: boolean; paused?: boolean; stopped?: boolean; noFeed?: boolean }> {
  const started = Date.now();
  ctx.state.cycles += 1;
  ctx.cycleStats = { deliveries: 0, reviews: 0, aux: 0, errors: 0 };
  ctx.state.lastCycleAt = new Date().toISOString();
  ctx.state.lastCycleMs = null;

  if (await isStopped(ctx.profilePaths)) return { stopped: true };
  if (await isPaused(ctx.profilePaths)) {
    ctx.logger.info("Paused; waiting for resume");
    return { paused: true };
  }

  await poll(ctx.primary.client, ctx.profile, ctx.profilePaths, ctx.state, {
    logger: ctx.logger,
    markInboxRead: !ctx.dryRun,
    clientForName: (name) => clientByName(ctx, name)?.client ?? null
  });

  const maxAge = ctx.profile.memoryRefreshMinutes;
  const loadedAt = ctx.memory?.loadedAt ? new Date(ctx.memory.loadedAt).getTime() : 0;
  if (!ctx.memory || Date.now() - loadedAt > maxAge * 60 * 1000) {
    ctx.memory = await loadMemoryContext(ctx.primary.client, ctx.profilePaths, { maxAgeMinutes: maxAge });
    ctx.memoryText = formatMemoryForPrompt(ctx.memory);
    ctx.logger.info("Memory refreshed", { notes: ctx.memory.ownNotes.length });
  }

  const feed = await fetchMergedFeed(ctx);
  if (!feed) {
    ctx.logger.warn("No work feed available this cycle");
    return { noFeed: true };
  }
  ctx.feed = feed;

  for (const task of Object.values(ctx.state.tasks)) {
    if (task.status === "working" && Date.now() - new Date(task.updatedAt).getTime() > 60 * 60 * 1000) {
      task.status = "queued";
      task.lastError = "stale working task reset";
    }
  }

  ctx.platform = await loadPlatformSets(ctx);
  const platformNumbers = new Set(ctx.platform.issues.map((issue) => issue.number));
  const platformIdeaNumbers = new Set(ctx.platform.ideas.map((idea) => idea.number));
  ctx.queue = buildQueue({
    feed,
    profile: ctx.profile,
    platformNumbers,
    platformIdeaNumbers,
    state: ctx.state
  });

  if (ctx.dryRun) {
    ctx.logger.info("Dry run: queue built; no Ziki or GitHub writes", {
      queue: ctx.queue.counts,
      owner: ctx.queue.owner.length,
      work: ctx.queue.work.slice(0, 5).map((entry) => `${entry.kind} #${entry.issueNumber}`),
      review: ctx.queue.review.slice(0, 5).map((entry) => `${entry.kind} #${entry.issueNumber}`),
      aux: ctx.queue.aux.slice(0, 5).map((entry) => `${entry.kind} #${entry.issueNumber ?? entry.ideaNumber}`)
    });
    ctx.state.lastCycleAt = new Date().toISOString();
    ctx.state.lastCycleMs = Date.now() - started;
    await save(ctx);
    return { ok: true, dryRun: true };
  }

  await heartbeatPass(ctx);
  if (ctx.repoReady) await ensureBaseline(ctx).catch((error) => ctx.logger.warn(`Baseline failed: ${error instanceof Error ? error.message : String(error)}`));
  dispatch(ctx);
  await cleanupOldWorktrees(ctx);

  pruneState(ctx.state);
  ctx.state.lastCycleMs = Date.now() - started;
  await save(ctx);
  ctx.logger.info("Cycle complete", {
    cycles: ctx.state.cycles,
    ms: ctx.state.lastCycleMs,
    queue: ctx.queue.counts,
    inFlight: ctx.pool.total(),
    deliveries: counter(ctx).deliveries,
    reviews: counter(ctx).reviews
  });
  return { ok: true };
}

function discoveryDue(ctx: Context): boolean {
  if (!ctx.profile.discovery.enabled) return false;
  if (counter(ctx).discoveries >= ctx.profile.limits.maxDiscoveriesPerDay) return false;
  const every = ctx.profile.discovery.maxCyclesBeforeRun ?? ctx.profile.limits.maxCyclesBeforeDiscovery;
  return ctx.state.cycles > 0 && ctx.state.cycles % every === 0;
}

function nextItem(ctx: Context, bucket: QueueEntry[] | undefined): QueueEntry | null {
  return (bucket ?? []).find((entry) => !ctx.pool.has(entry.key) && entry.item.canAct !== false) ?? null;
}

async function processWorkSafe(ctx: Context, item: QueueEntry, worker?: AgentClient): Promise<void> {
  try {
    await processWorkItem(ctx, item, worker);
  } catch (error) {
    ctx.logger.error(`Delivery for #${item.issueNumber} crashed: ${error instanceof Error ? error.message : String(error)}`);
    counter(ctx).errors += 1;
    ctx.cycleStats.errors += 1;
    history(ctx, { type: "failure", issue: item.issueNumber, detail: error instanceof Error ? error.message : String(error) });
    markRecent(ctx, item.key);
    await save(ctx).catch(() => {});
  }
}

async function processReviewSafe(ctx: Context, item: QueueEntry): Promise<void> {
  try {
    if (item.kind === "test_fix") await processTestFix(ctx, item);
    else if (item.kind === "accept_fix") await processAccept(ctx, item);
  } catch (error) {
    ctx.logger.error(`Review for #${item.issueNumber} crashed: ${error instanceof Error ? error.message : String(error)}`);
    counter(ctx).errors += 1;
    ctx.cycleStats.errors += 1;
    history(ctx, { type: "failure", issue: item.issueNumber, detail: error instanceof Error ? error.message : String(error) });
    markRecent(ctx, item.key);
    await save(ctx).catch(() => {});
  }
}

function dispatch(ctx: Context): void {
  const limits = ctx.profile.limits;
  const pool = ctx.pool;
  ctx.auxThisCycle = 0;

  if (pool.canStart("owner")) {
    const owner = nextItem(ctx, ctx.queue?.owner);
    if (owner) pool.reserve(owner.key, "owner", () => processOwnerItem(ctx, owner));
  }

  const maxDeliveries = Math.max(0, Math.min(limits.maxConcurrentDeliveries ?? 2, limits.maxActiveClaims));
  while (pool.canStart("delivery") && pool.count("delivery") < maxDeliveries) {
    if (activeClaims(ctx).length + pool.count("delivery") >= limits.maxActiveClaims) break;
    if (counter(ctx).deliveries >= limits.maxDeliveriesPerDay) break;
    if (limits.maxDeliveriesTotal != null && ctx.state.run.deliveries >= limits.maxDeliveriesTotal) break;
    const item = (ctx.queue?.work ?? []).find((entry) => {
      if (!entry.issueId || pool.has(entry.key)) return false;
      const task = ctx.state.tasks[entry.issueId];
      return !task || !["waiting_human", "delivered", "done", "failed", "skipped"].includes(task.status);
    });
    if (!item) break;
    const worker = pickAvailableWorker(ctx);
    if (!worker) break;
    ctx.reservedAgents.add(worker.name);
    pool.reserve(item.key, "delivery", async () => {
      try {
        await processWorkSafe(ctx, item, worker);
      } finally {
        ctx.reservedAgents.delete(worker.name);
      }
    });
  }

  while (pool.canStart("review")) {
    if (counter(ctx).reviews >= limits.maxReviewsPerDay) break;
    const item = nextItem(ctx, ctx.queue?.review);
    if (!item) break;
    pool.reserve(item.key, "review", () => processReviewSafe(ctx, item));
  }

  while (pool.canStart("aux") && ctx.auxThisCycle < limits.maxAuxPerCycle) {
    const item = nextItem(ctx, ctx.queue?.aux);
    if (!item) break;
    ctx.auxThisCycle += 1;
    pool.reserve(item.key, "aux", async () => {
      await processAuxItem(ctx, item);
      await save(ctx).catch(() => {});
    });
  }

  if (pool.canStart("discovery") && discoveryDue(ctx) && !pool.has("discovery")) {
    pool.reserve("discovery", "discovery", () => discoveryPass(ctx));
  }
}

async function createContext(
  loaded: LoadedProfile,
  state: State,
  logger: Logger,
  options: { dryRun: boolean; runLimits: RunLimitConfig }
): Promise<Context> {
  const { profile, profileName, keys } = loaded;
  const toClients = (agents: AgentKey[]): AgentClient[] =>
    agents.map((agent) => ({ ...agent, client: clientForAgent(agent, profile) }));
  const clients = {
    workers: toClients(keys.workers),
    managers: toClients(keys.managers)
  };
  const primary = clients.workers[0] ?? clients.managers[0];
  if (!primary) throw new Error("No valid agent keys. Add them to the env file.");

  const github = new GitHub({ profile, profileName, reposDir: loaded.profilePaths.reposDir, logger });
  let repoReady = false;
  try {
    await github.ensureRepo();
    repoReady = true;
  } catch (error) {
    logger.error(`Repo not ready: ${error instanceof Error ? error.message : String(error)}`);
  }

  const memory = await loadMemoryContext(primary.client, loaded.profilePaths, {
    maxAgeMinutes: profile.memoryRefreshMinutes
  }).catch(() => null);

  return {
    loaded,
    config: loaded.config,
    profile,
    profileName,
    profilePaths: loaded.profilePaths,
    state,
    logger,
    clients,
    primary,
    github,
    repoReady,
    memory,
    memoryText: formatMemoryForPrompt(memory),
    feedCache: {},
    feed: null,
    queue: null,
    platform: { issues: [], ideas: [], fetchedAt: null },
    dryRun: options.dryRun,
    pool: new TaskPool({
      delivery: profile.limits.maxConcurrentDeliveries ?? 2,
      review: profile.limits.maxConcurrentReviews ?? 1,
      aux: profile.limits.maxConcurrentAux ?? 2,
      discovery: profile.limits.maxConcurrentDiscovery ?? 1,
      owner: 1,
      agents: profile.limits.maxConcurrentAgents ?? 4
    }),
    mutex: new Mutex(),
    runLimits: options.runLimits,
    auxThisCycle: 0,
    reservedAgents: new Set(),
    cycleStats: { deliveries: 0, reviews: 0, aux: 0, errors: 0 }
  };
}

async function readRunLimitsFile(profilePaths: ProfilePaths): Promise<Partial<RunLimitConfig> | null> {
  if (!existsSync(profilePaths.runLimitsFile)) return null;
  try {
    return JSON.parse(await readFile(profilePaths.runLimitsFile, "utf8")) as Partial<RunLimitConfig>;
  } catch {
    return null;
  }
}

function killStalePids(state: State, logger: Logger): number[] {
  const alive: number[] = [];
  for (const pid of state.activePids ?? []) {
    if (!isAlive(pid)) continue;
    alive.push(pid);
    logger.warn(`Killing stale agent process from a previous run (pid ${pid})`);
    killProcessTree(pid);
  }
  state.activePids = [];
  return alive;
}

async function reconcileWorktreesOnStartup(ctx: Context, blockedPids: number[] = []): Promise<void> {
  if ([...(ctx.state.activePids ?? []), ...blockedPids].some((pid) => isAlive(pid))) {
    ctx.logger.warn("Skipping worktree cleanup: recorded agent processes are still alive");
    return;
  }
  for (const task of Object.values(ctx.state.tasks)) {
    if (!task.worktree) continue;
    if (!["done", "failed", "skipped"].includes(task.status)) continue;
    await cleanupWorktree(ctx.github, task.worktree);
    task.worktree = undefined;
  }
  const live = new Set(
    Object.values(ctx.state.tasks)
      .map((task) => task.worktree)
      .filter((value): value is string => Boolean(value))
  );
  const entries = await readdir(ctx.profilePaths.worktreesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(ctx.profilePaths.worktreesDir, entry.name);
    if (live.has(full)) continue;
    const info = await stat(full).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
    await cleanupWorktree(ctx.github, full);
    ctx.logger.info(`Removed stale worktree ${entry.name}`);
  }
}

function limitReached(ctx: Context): "max-cycles" | "max-deliveries" | "until" | "max-runtime" | null {
  const limits = ctx.runLimits;
  if (limits.maxCycles !== null && ctx.state.cycles >= limits.maxCycles) return "max-cycles";
  if (limits.maxDeliveriesTotal !== null && ctx.state.run.deliveries >= limits.maxDeliveriesTotal) return "max-deliveries";
  if (limits.stopAt) {
    const at = new Date(limits.stopAt).getTime();
    if (Number.isFinite(at) && Date.now() >= at) return "until";
  }
  if (limits.maxRuntimeMinutes !== null) {
    const started = ctx.state.run.startedAt ? new Date(ctx.state.run.startedAt).getTime() : Date.now();
    if (Date.now() - started >= limits.maxRuntimeMinutes * 60 * 1000) return "max-runtime";
  }
  return null;
}

export async function runLoop(options: {
  profileName?: string;
  foreground?: boolean;
  once?: boolean;
  dryRun?: boolean;
  limits?: Partial<RunLimitConfig> | null;
} = {}): Promise<number> {
  const loaded = await loadProfile(options.profileName);
  const logger = createLogger({
    name: `auto-work.${loaded.profileName}`,
    logDir: loaded.profilePaths.logsDir,
    foreground: options.foreground !== false
  });
  const lock = await acquireLock(loaded.profilePaths);
  if (!lock.acquired) {
    logger.error(`Another auto-work loop is running for profile "${loaded.profileName}" (pid ${lock.pid}).`);
    return 1;
  }

  const state = await loadState(loaded.profilePaths);
  state.profile = loaded.profileName;
  state.startedAt ??= new Date().toISOString();
  state.stoppedAt = null;
  const stalePids = killStalePids(state, logger);
  for (const task of Object.values(state.tasks)) {
    if (task.status === "working") task.status = "queued";
  }
  const storedLimits = await readRunLimitsFile(loaded.profilePaths);
  const runLimits = resolveRunLimits(loaded.profile, options.limits ?? storedLimits ?? null);
  state.run = {
    startedAt: new Date().toISOString(),
    limits: runLimits,
    stopReason: null,
    deliveries: 0
  };
  state.lastCycle = null;
  await saveState(loaded.profilePaths, state);
  await writePid(loaded.profilePaths, process.pid);

  let ctx: Context;
  try {
    ctx = await createContext(loaded, state, logger, { dryRun: Boolean(options.dryRun), runLimits });
  } catch (error) {
    logger.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    await releaseLock(loaded.profilePaths);
    await clearPid(loaded.profilePaths);
    return 1;
  }
  await reconcileWorktreesOnStartup(ctx, stalePids).catch(() => {});

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info(`Stopping on ${signal}`);
    controller.abort();
    killActiveAgents();
  };
  const onSigint = (): void => shutdown("SIGINT");
  const onSigterm = (): void => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  logger.info("Auto-work loop started", {
    profile: ctx.profileName,
    provider: ctx.profile.executor.provider,
    workers: ctx.clients.workers.map((agent) => agent.name),
    managers: ctx.clients.managers.map((agent) => agent.name),
    pollSeconds: ctx.profile.pollSeconds,
    repoReady: ctx.repoReady,
    runLimits
  });
  await writeStatus(ctx, { running: true });

  let stopReason: StopReason = null;
  try {
    do {
      if (controller.signal.aborted) {
        stopReason ??= "stop";
        break;
      }
      if (await isStopped(ctx.profilePaths)) {
        stopReason = "stop";
        break;
      }
      if (await isPaused(ctx.profilePaths)) {
        await sleep(30_000, controller.signal);
        continue;
      }
      try {
        await runCycle(ctx);
      } catch (error) {
        ctx.state.lastError = {
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
          stack: truncate(error instanceof Error ? error.stack : "", 1500)
        };
        logger.error(`Cycle failed: ${error instanceof Error ? error.message : String(error)}`);
        await save(ctx).catch(() => {});
        if (options.once) {
          stopReason = "error";
          break;
        }
      }
      if (options.once) {
        await ctx.pool.drain(120_000);
        break;
      }
      const reason = limitReached(ctx);
      if (reason) {
        stopReason = reason;
        logger.info(`Run limit reached: ${reason}`, { cycles: ctx.state.cycles, deliveries: ctx.state.run.deliveries });
        await ctx.pool.drain(120_000);
        break;
      }
      await Promise.race([ctx.pool.waitForAny(), sleep(ctx.profile.pollSeconds * 1000, controller.signal)]);
    } while (!controller.signal.aborted);
  } catch (error) {
    stopReason = "error";
    ctx.state.lastError = {
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stack: truncate(error instanceof Error ? error.stack : "", 1500)
    };
    logger.error(`Loop failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (!stopReason && controller.signal.aborted) stopReason = "stop";
    ctx.state.run.stopReason = stopReason;
    ctx.state.stoppedAt = new Date().toISOString();
    const hardStop = stopReason === "stop" || stopReason === "error" || controller.signal.aborted;
    if (hardStop) {
      controller.abort();
      killActiveAgents();
    }
    await ctx.pool.drain(30_000);
    if (ctx.pool.total()) {
      killActiveAgents();
      await ctx.pool.drain(5_000);
    }
    ctx.state.activePids = [];
    await save(ctx).catch(() => {});
    await writeStatus(ctx, { running: false }).catch(() => {});
    await releaseLock(loaded.profilePaths);
    await clearPid(loaded.profilePaths);
    logger.info("Auto-work loop stopped", { stopReason });
  }
  return 0;
}

export async function runOnceDry(profileName?: string): Promise<number> {
  return runLoop({ profileName, foreground: true, once: true, dryRun: true });
}
