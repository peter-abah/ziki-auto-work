import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentKey,
  CheckRunResult,
  Config,
  Idea,
  Issue,
  JobConfig,
  JobPaths,
  LoadedJob,
  Queue,
  QueueEntry,
  State,
  TaskState,
  WorkFeed,
  WorkItem
} from "./types.js";
import { loadJob, resolveParityFile } from "./config.js";
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
  pruneState
} from "./state.js";
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
  killActiveAgents
} from "./agent.js";
import { loadMemoryContext, formatMemoryForPrompt, recordTaskNote } from "./memory.js";
import type { MemoryContext } from "./memory.js";
import { escalate, poll, writeNeedsHuman } from "./hitl.js";
import { buildQueue, textMatchesPlatform } from "./queue.js";
import { runChecks, scanSecrets, protectedFiles } from "./checks.js";
import { jobPaths, paths } from "./platform/paths.js";
import { issueUrl } from "./urls.js";

const WORKABLE = new Set(["requires_confirmation", "open", "in_progress"]);
const TERMINAL = new Set(["resolved", "closed"]);

interface AgentClient {
  name: string;
  key: string;
  client: ZikiClient;
}

interface Context {
  loaded: LoadedJob;
  config: Config;
  job: JobConfig;
  jobName: string;
  jobPaths: JobPaths;
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
  return ctx.clients.workers.find((agent) => !excluded.has(agent.name)) ?? null;
}

function pickManager(ctx: Context, exclude: string[] = []): AgentClient | null {
  const excluded = new Set(exclude.filter(Boolean));
  return ctx.clients.managers.find((agent) => !excluded.has(agent.name)) ?? null;
}

function counter(ctx: Context) {
  return counterFor(ctx.state);
}

function markRecent(ctx: Context, key: string): void {
  ctx.state.recentFeedKeys[key] = Date.now();
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

async function writeStatus(ctx: Context, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tasks = Object.values(ctx.state.tasks);
  const open = Object.values(ctx.state.escalations).filter((escalation) => escalation.status === "open");
  const status = {
    job: ctx.jobName,
    pid: process.pid,
    running: extra.running ?? true,
    dryRun: Boolean(ctx.dryRun),
    paused: await isPaused(ctx.jobPaths),
    stopped: await isStopped(ctx.jobPaths),
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
    counters: counter(ctx),
    escalations: open.map((escalation) => ({
      id: escalation.id,
      issue: escalation.issueNumber,
      type: escalation.type,
      body: truncate(escalation.body, 300),
      createdAt: escalation.createdAt
    })),
    memoryLoadedAt: ctx.memory?.loadedAt ?? null,
    repoReady: ctx.repoReady,
    lastError: ctx.state.lastError,
    ...extra
  };
  await mkdir(ctx.jobPaths.stateDir, { recursive: true });
  await writeFile(ctx.jobPaths.statusFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return status;
}

async function save(ctx: Context): Promise<void> {
  await saveState(ctx.jobPaths, ctx.state);
  await writeStatus(ctx);
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
  const file = ctx.jobPaths.desktopCacheFile;
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
      ctx.primary.client.listAllIssues({ platform: ctx.job.ziki.platform, max: 600 }),
      ctx.primary.client.listAllIdeas({ platform: ctx.job.ziki.platform, max: 600 })
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
  const dir = path.join(ctx.jobPaths.worktreesDir, `scratch-${slugify(label, 60)}`);
  await ctx.github.createScratchWorktree(dir);
  try {
    return await fn(dir);
  } finally {
    await cleanupWorktree(ctx.github, dir);
  }
}

async function ownerPass(ctx: Context): Promise<void> {
  const item = ctx.queue?.owner[0];
  if (!item) return;
  const requestId = String(item.key).split(":")[1] ?? "";
  const agent = clientByName(ctx, item.item._feedAgent) ?? ctx.primary;
  const request = { id: requestId, body: item.detail };
  ctx.logger.info(`Owner request ${requestId}: ${truncate(request.body, 160)}`);

  const result = await withScratch(ctx, `owner-${requestId}`, (dir) =>
    runOwner({
      job: ctx.job,
      jobPaths: ctx.jobPaths,
      request,
      memoryText: ctx.memoryText,
      repoDir: dir,
      logger: ctx.logger
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
  const existing = existsSync(ctx.jobPaths.ownerRequestsFile) ? await readFile(ctx.jobPaths.ownerRequestsFile, "utf8") : "# Owner requests\n\n";
  await writeFile(ctx.jobPaths.ownerRequestsFile, `${existing}${block}\n`, "utf8");
}

async function deliveryPass(ctx: Context): Promise<void> {
  const limits = ctx.job.limits;
  if (counter(ctx).deliveries >= limits.maxDeliveriesPerDay) return;
  if (activeClaims(ctx).length >= limits.maxActiveClaims) return;
  const item = ctx.queue?.work.find((entry) => {
    if (!entry.issueId) return false;
    const task = ctx.state.tasks[entry.issueId];
    return !task || !["waiting_human", "delivered", "done", "failed", "skipped"].includes(task.status);
  });
  if (!item) return;
  try {
    await processWorkItem(ctx, item);
  } catch (error) {
    ctx.logger.error(`Delivery for #${item.issueNumber} crashed: ${error instanceof Error ? error.message : String(error)}`);
    markRecent(ctx, item.key);
    await save(ctx).catch(() => {});
  }
}

async function processWorkItem(ctx: Context, item: QueueEntry): Promise<void> {
  const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
  const issue = normalizeIssue(data);
  if (!issue) return;

  if (TERMINAL.has(issue.status)) {
    setTask(ctx.state, issue, { status: "skipped", reason: `issue is ${issue.status}` });
    markRecent(ctx, item.key);
    return;
  }
  if (issue.platform?.slug && issue.platform.slug !== ctx.job.ziki.platform) {
    markRecent(ctx, item.key);
    return;
  }
  if (issue.holder && issue.holder.status === "active" && !isOurAgent(ctx, issue.holder.agentName)) {
    ctx.logger.debug(`#${issue.number} held by ${issue.holder.agentName}; skipping`);
    markRecent(ctx, item.key);
    return;
  }
  if (issue.pullRequestUrl && !(issue.holder && isOurAgent(ctx, issue.holder.agentName))) {
    ctx.logger.debug(`#${issue.number} already has PR ${issue.pullRequestUrl}; skipping`);
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
  const claim = await ensureClaim(ctx, issue);
  if (!claim) {
    markRecent(ctx, item.key);
    return;
  }

  const worker = claim.agent;
  const branch = branchName(issue, issue.title);
  const dir = await prepareWorktree(ctx.github, ctx.jobPaths, issue, branch);
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
      job: ctx.job,
      jobPaths: ctx.jobPaths,
      issue,
      memoryText: ctx.memoryText,
      worktree: dir,
      branch,
      base: ctx.job.repo.base,
      previousError: ctx.state.tasks[taskKey(issue)]?.lastError ?? "",
      issueContext,
      logger: ctx.logger
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
  const protectedHits = protectedFiles(changed, ctx.job.repo.protectedFiles);
  if (protectedHits.length) {
    return handleWorkFailure(ctx, issue, item, { error: `protected files changed: ${protectedHits.join(", ")}` }, worker, dir);
  }

  const diff = await ctx.github
    .git(["diff", "--cached", `upstream/${ctx.job.repo.base}`], { cwd: dir })
    .then((output) => output.stdout)
    .catch(() => "");
  const secretHits = scanSecrets(diff);
  if (secretHits.length) {
    return handleWorkFailure(ctx, issue, item, { error: `possible secret in diff: ${secretHits[0]}` }, worker, dir);
  }

  const checks = await runChecks(ctx.job, dir, {
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
  const body = await buildPrBody(ctx.job, {
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
  markRecent(ctx, item.key);
  await recordTaskNote(worker.client, ctx.state.tasks[taskKey(issue)]!, "delivered", result.summary, result.description, ctx.state, worker.name);
  ctx.logger.info(`Delivered #${issue.number}`, { pr: pr.url, branch, files: changed.length });
  await save(ctx);
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
  const maxAttempts = ctx.job.limits.maxAttemptsPerTask;
  const error = result.error ?? result.blocker ?? "unknown failure";
  ctx.logger.warn(`#${issue.number} attempt ${attempts} failed: ${truncate(error, 300)}`);
  ctx.state.lastError = { at: new Date().toISOString(), issue: issue.number, error: truncate(error, 500) };

  await cleanupWorktree(ctx.github, dir);

  if (result.blocked) {
    const escalation = await escalate(worker.client, ctx.job, ctx.jobPaths, ctx.state, {
      issue,
      type: "blocker",
      body: `#${issue.number} needs a human: ${result.blocker ?? result.summary ?? error}`,
      agentName: worker.name,
      logger: ctx.logger,
      notifyCommand: ctx.job.hitl.notifyCommand,
      maxOpen: ctx.job.limits.maxOpenEscalations
    });
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
    const manager = pickManager(ctx);
    if (!manager) return false;
    const result = await withScratch(ctx, `confirm-${issue.number}`, (dir) =>
      runConfirm({
        job: ctx.job,
        jobPaths: ctx.jobPaths,
        issue,
        memoryText: ctx.memoryText,
        repoDir: dir,
        logger: ctx.logger
      })
    );
    if (!result.ok) {
      if (result.blocked) {
        await escalate(manager.client, ctx.job, ctx.jobPaths, ctx.state, {
          issue,
          type: "blocker",
          body: `Cannot confirm #${issue.number}: ${result.blocker ?? result.summary ?? result.error ?? "unknown"}`,
          agentName: manager.name,
          logger: ctx.logger,
          notifyCommand: ctx.job.hitl.notifyCommand,
          maxOpen: ctx.job.limits.maxOpenEscalations
        });
      }
      return false;
    }
    if (result.verdict !== "confirm") {
      setTask(ctx.state, issue, { status: "skipped", reason: `confirmation verdict: ${result.verdict ?? "unknown"}` });
      await save(ctx);
      return false;
    }
    const confirmation = await manager.client.confirmIssue(issue.id, {
      verdict: "confirm",
      summary: result.summary ?? `Confirmed #${issue.number}`,
      description: result.description ?? "",
      files: fileEvidence(result.files),
      duplicateOfId: result.duplicateOfId ?? undefined
    });
    if (confirmation?.confirmed) await manager.client.openIssue(issue.id).catch(() => {});
    return true;
  }

  if (issue.status === "open" || issue.substatus === "open") return true;
  return issue.status === "in_progress" || issue.substatus === "in_progress";
}

async function ensureBidAndAward(ctx: Context, issue: Issue): Promise<{ agent: AgentClient; claimId: string } | null> {
  const worker = pickWorker(ctx);
  const manager = pickManager(ctx);
  if (!worker || !manager) return null;

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
      `Plan: reproduce the issue in ${ctx.job.ziki.platform}, make the smallest scoped fix, add a regression test, run the configured checks, and deliver a PR with evidence.`,
      "",
      `Ticket: #${issue.number} ${issue.title}`,
      issue.summary ? `Reported: ${issue.summary}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    const created = await worker.client.bid(issue.id, { summary, description });
    bidId = created.bid_id ?? created.id ?? created.bidId ?? null;
  }
  if (!bidId) return null;

  let award;
  try {
    award = await manager.client.awardBid(bidId);
  } catch (error) {
    ctx.logger.warn(`Award failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const claimId = award.claimId ?? award.claim_id;
  if (!claimId) return null;

  try {
    await worker.client.acceptOffer(claimId);
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
  await save(ctx);
  return { agent: worker, claimId };
}

async function ensureClaim(ctx: Context, issue: Issue): Promise<{ agent: AgentClient; claimId: string } | null> {
  const holder = issue.holder;
  if (holder) {
    const agent = clientByName(ctx, holder.agentName);
    if (!agent) return null;
    if (holder.status === "active") {
      setTask(ctx.state, issue, { status: "claimed", agentName: agent.name, claimId: holder.id, lastHeartbeatAt: new Date().toISOString() });
      return { agent, claimId: holder.id };
    }
    if (holder.status === "offered") {
      try {
        await agent.client.acceptOffer(holder.id);
        setTask(ctx.state, issue, { status: "claimed", agentName: agent.name, claimId: holder.id, lastHeartbeatAt: new Date().toISOString() });
        return { agent, claimId: holder.id };
      } catch (error) {
        ctx.logger.warn(`Could not accept existing offer for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
  }
  return ensureBidAndAward(ctx, issue);
}

async function reviewPass(ctx: Context): Promise<void> {
  if (counter(ctx).reviews >= ctx.job.limits.maxReviewsPerDay) return;
  const item = ctx.queue?.review[0];
  if (!item) return;
  try {
    if (item.kind === "test_fix") await processTestFix(ctx, item);
    else if (item.kind === "accept_fix") await processAccept(ctx, item);
  } catch (error) {
    ctx.logger.error(`Review for #${item.issueNumber} crashed: ${error instanceof Error ? error.message : String(error)}`);
    markRecent(ctx, item.key);
    await save(ctx).catch(() => {});
  }
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

  const dir = await prepareReviewWorktree(ctx.github, ctx.jobPaths, prNumber);
  let result;
  try {
    result = await runReview({
      job: ctx.job,
      jobPaths: ctx.jobPaths,
      issue,
      memoryText: ctx.memoryText,
      worktree: dir,
      prUrl: issue.pullRequestUrl,
      headSha: issue.pullRequestHeadSha ?? "",
      logger: ctx.logger
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
  markRecent(ctx, item.key);
  ctx.logger.info(`Accepted #${issue.number}`, { manager: manager.name });
  await save(ctx);
}

async function auxPass(ctx: Context): Promise<void> {
  const limit = ctx.job.limits.maxAuxPerCycle;
  let handled = 0;
  for (const item of ctx.queue?.aux ?? []) {
    if (handled >= limit) break;
    if (item.item.canAct === false) continue;
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
          did = false;
      }
      if (did) {
        counter(ctx).aux += 1;
        handled += 1;
      }
    } catch (error) {
      ctx.logger.warn(`Aux ${item.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
      markRecent(ctx, item.key);
    }
  }
  if (handled) await save(ctx);
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
    await ctx.github.git(["fetch", "upstream", ctx.job.repo.defaultBranch]);
    const result = await ctx.github.git(["merge-base", "--is-ancestor", sha, `upstream/${ctx.job.repo.defaultBranch}`]);
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
  const manager = pickManager(ctx);
  if (!manager) return false;
  let did = 0;
  try {
    const issues = await manager.client.listAllIssues({ platform: "none", max: 100 });
    for (const issue of issues) {
      if (did >= 5) break;
      if (!textMatchesPlatform(ctx.job, `${issue.title} ${issue.summary ?? ""}`)) continue;
      await manager.client.categorizeIssue(issue.id, {
        platform: ctx.job.ziki.platform,
        reason: "Title/summary matches this job's platform."
      });
      did += 1;
    }
    const ideas = await manager.client.listAllIdeas({ platform: "none", max: 100 });
    for (const idea of ideas) {
      if (did >= 5) break;
      if (!textMatchesPlatform(ctx.job, `${idea.title} ${idea.summary ?? ""}`)) continue;
      await manager.client.categorizeIdea(idea.id, {
        platform: ctx.job.ziki.platform,
        reason: "Title/summary matches this job's platform."
      });
      did += 1;
    }
  } catch (error) {
    ctx.logger.warn(`Categorize failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  markRecent(ctx, item.key);
  if (did) ctx.logger.info(`Categorized ${did} items`);
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
  if (!manager) {
    markRecent(ctx, item.key);
    return false;
  }
  const result = await withScratch(ctx, `triage-${idea.number}`, (dir) =>
    runTriage({
      job: ctx.job,
      jobPaths: ctx.jobPaths,
      idea,
      memoryText: ctx.memoryText,
      repoDir: dir,
      logger: ctx.logger
    })
  );
  if (!result.ok) {
    markRecent(ctx, item.key);
    return false;
  }
  const opinion = result.opinion && ["good", "bad", "neutral"].includes(result.opinion) ? result.opinion : "neutral";
  await manager.client.giveIdeaVerdict(idea.id, {
    opinion,
    votes: opinion === "good" ? 3 : 1,
    summary: result.summary ?? `Triage: ${opinion}`,
    description: result.description ?? ""
  });
  if (opinion === "good") {
    try {
      const verdicts = await manager.client.ideaVerdicts(idea.id);
      if (verdicts?.convertible) {
        await manager.client.convertIdea(idea.id);
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
  const manager = pickManager(ctx);
  if (!manager) return false;
  const result = await withScratch(ctx, `confirm-aux-${issue.number}`, (dir) =>
    runConfirm({
      job: ctx.job,
      jobPaths: ctx.jobPaths,
      issue,
      memoryText: ctx.memoryText,
      repoDir: dir,
      logger: ctx.logger
    })
  );
  if (!result.ok) {
    markRecent(ctx, item.key);
    return false;
  }
  const verdict = result.verdict && ["confirm", "reject", "neutral"].includes(result.verdict) ? result.verdict : "neutral";
  const response = await manager.client.confirmIssue(issue.id, {
    verdict,
    summary: result.summary ?? `Confirmation: ${verdict}`,
    description: result.description ?? "",
    files: fileEvidence(result.files),
    duplicateOfId: result.duplicateOfId ?? undefined
  });
  if (response?.confirmed) await manager.client.openIssue(issue.id).catch(() => {});
  markRecent(ctx, item.key);
  return true;
}

async function discoveryPass(ctx: Context): Promise<void> {
  if (!ctx.job.discovery.enabled) return;
  if (counter(ctx).discoveries >= ctx.job.limits.maxDiscoveriesPerDay) return;
  const every = ctx.job.discovery.maxCyclesBeforeRun ?? ctx.job.limits.maxCyclesBeforeDiscovery;
  if (ctx.state.cycles % every !== 0) return;

  const existing = (ctx.platform.issues ?? [])
    .filter((issue) => ["open", "in_progress", "done", "merge"].includes(issue.status))
    .slice(0, 60)
    .map((issue) => `#${issue.number} ${issue.title}`)
    .join("\n");

  const parityFile = resolveParityFile(ctx.job);
  const parity = parityFile && existsSync(parityFile) ? await readFile(parityFile, "utf8") : "(no parity map yet)";

  const result = await withScratch(ctx, "discovery", (dir) =>
    runDiscovery({
      job: ctx.job,
      jobPaths: ctx.jobPaths,
      memoryText: ctx.memoryText,
      repoDir: dir,
      parity,
      existingIssues: existing,
      maxIdeas: ctx.job.discovery.maxIdeasPerRun ?? 3,
      logger: ctx.logger
    })
  );

  if (!result.ok) {
    ctx.logger.warn(`Discovery failed: ${result.error ?? result.blocker ?? "unknown"}`);
    return;
  }
  const ideas = (result.ideas ?? []).slice(0, ctx.job.discovery.maxIdeasPerRun ?? 3);
  for (const idea of ideas) {
    if (!idea?.title || !idea?.description) continue;
    try {
      let summary = idea.summary || idea.title;
      if (summary.length < 20) summary = `${summary} — platform parity gap.`;
      const created = await ctx.primary.client.createIdea({
        title: idea.title.slice(0, 200),
        summary: summary.slice(0, 300),
        description: idea.description.slice(0, 5000),
        platform: ctx.job.ziki.platform,
        idempotencyKey: `aw-${ctx.jobName}-${new Date().toISOString().slice(0, 10)}-${slugify(idea.title, 50)}`,
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
    await recordTaskNote(ctx.primary.client, { id: "discovery", number: "discovery", title: "Discovery" }, "discovery", `Filed ${ideas.length} idea(s)`, ideas.map((idea) => `- ${idea.title}`).join("\n"), ctx.state, ctx.primary.name);
  }
  await save(ctx);
}

async function ensureBaseline(ctx: Context): Promise<void> {
  const baselineChecks = ctx.job.checks.filter((check) => check.baseline);
  if (!baselineChecks.length) return;
  const sha = await ctx.github.baseSha().catch(() => null);
  if (ctx.state.baselineSha === sha && ctx.state.baselineAt) return;

  const dir = path.join(ctx.jobPaths.worktreesDir, "scratch-baseline");
  await ctx.github.createScratchWorktree(dir);
  try {
    const changedFiles = ctx.job.repo.baselineFile ? [ctx.job.repo.baselineFile] : [];
    const checks = await runChecks(ctx.job, dir, { changedFiles, baselineFailures: {}, logger: ctx.logger });
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

  if (await isStopped(ctx.jobPaths)) return { stopped: true };
  if (await isPaused(ctx.jobPaths)) {
    ctx.logger.info("Paused; waiting for resume");
    return { paused: true };
  }

  await poll(ctx.primary.client, ctx.job, ctx.jobPaths, ctx.state, {
    logger: ctx.logger,
    markInboxRead: !ctx.dryRun,
    clientForName: (name) => clientByName(ctx, name)?.client ?? null
  });

  const maxAge = ctx.job.memoryRefreshMinutes;
  const loadedAt = ctx.memory?.loadedAt ? new Date(ctx.memory.loadedAt).getTime() : 0;
  if (!ctx.memory || Date.now() - loadedAt > maxAge * 60 * 1000) {
    ctx.memory = await loadMemoryContext(ctx.primary.client, ctx.jobPaths, { maxAgeMinutes: maxAge });
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
    job: ctx.job,
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
  await ownerPass(ctx);
  await deliveryPass(ctx);
  await reviewPass(ctx);
  await auxPass(ctx);
  await discoveryPass(ctx);
  await cleanupOldWorktrees(ctx);

  pruneState(ctx.state);
  ctx.state.lastCycleAt = new Date().toISOString();
  ctx.state.lastCycleMs = Date.now() - started;
  await save(ctx);
  ctx.logger.info("Cycle complete", {
    cycles: ctx.state.cycles,
    ms: ctx.state.lastCycleMs,
    queue: ctx.queue.counts,
    deliveries: counter(ctx).deliveries,
    reviews: counter(ctx).reviews
  });
  return { ok: true };
}

async function createContext(loaded: LoadedJob, state: State, logger: Logger, options: { dryRun: boolean }): Promise<Context> {
  const { job, jobName, keys } = loaded;
  const toClients = (agents: AgentKey[]): AgentClient[] =>
    agents.map((agent) => ({ ...agent, client: clientForAgent(agent, job) }));
  const clients = {
    workers: toClients(keys.workers),
    managers: toClients(keys.managers)
  };
  const primary = clients.workers[0] ?? clients.managers[0];
  if (!primary) throw new Error("No valid agent keys. Add them to the env file.");

  const github = new GitHub({ job, jobName, reposDir: loaded.jobPaths.reposDir, logger });
  let repoReady = false;
  try {
    await github.ensureRepo();
    repoReady = true;
  } catch (error) {
    logger.error(`Repo not ready: ${error instanceof Error ? error.message : String(error)}`);
  }

  const memory = await loadMemoryContext(primary.client, loaded.jobPaths, {
    maxAgeMinutes: job.memoryRefreshMinutes
  }).catch(() => null);

  return {
    loaded,
    config: loaded.config,
    job,
    jobName,
    jobPaths: loaded.jobPaths,
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
    dryRun: options.dryRun
  };
}

export async function runLoop(options: {
  jobName?: string;
  foreground?: boolean;
  once?: boolean;
  dryRun?: boolean;
} = {}): Promise<number> {
  const loaded = await loadJob(options.jobName);
  const logger = createLogger({
    name: `auto-work.${loaded.jobName}`,
    logDir: loaded.jobPaths.logsDir,
    foreground: options.foreground !== false
  });
  const lock = await acquireLock(loaded.jobPaths);
  if (!lock.acquired) {
    logger.error(`Another auto-work loop is running for job "${loaded.jobName}" (pid ${lock.pid}).`);
    return 1;
  }

  const state = await loadState(loaded.jobPaths);
  state.job = loaded.jobName;
  state.startedAt ??= new Date().toISOString();
  state.stoppedAt = null;
  for (const task of Object.values(state.tasks)) {
    if (task.status === "working") task.status = "queued";
  }
  await saveState(loaded.jobPaths, state);
  await writePid(loaded.jobPaths, process.pid);

  let ctx: Context;
  try {
    ctx = await createContext(loaded, state, logger, { dryRun: Boolean(options.dryRun) });
  } catch (error) {
    logger.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    await releaseLock(loaded.jobPaths);
    await clearPid(loaded.jobPaths);
    return 1;
  }

  const controller = new AbortController();
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Stopping on ${signal}`);
    killActiveAgents();
    controller.abort();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Auto-work loop started", {
    job: ctx.jobName,
    provider: ctx.job.executor.provider,
    workers: ctx.clients.workers.map((agent) => agent.name),
    managers: ctx.clients.managers.map((agent) => agent.name),
    pollSeconds: ctx.job.pollSeconds,
    repoReady: ctx.repoReady
  });
  await writeStatus(ctx, { running: true });

  try {
    do {
      if (controller.signal.aborted || (await isStopped(ctx.jobPaths))) break;
      if (await isPaused(ctx.jobPaths)) {
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
      }
      if (options.once) break;
      await sleep(ctx.job.pollSeconds * 1000, controller.signal);
    } while (!controller.signal.aborted);
  } finally {
    state.stoppedAt = new Date().toISOString();
    await saveState(loaded.jobPaths, state).catch(() => {});
    await writeStatus(ctx, { running: false }).catch(() => {});
    await releaseLock(loaded.jobPaths);
    await clearPid(loaded.jobPaths);
    logger.info("Auto-work loop stopped");
  }
  return 0;
}

export async function runOnceDry(jobName?: string): Promise<number> {
  return runLoop({ jobName, foreground: true, once: true, dryRun: true });
}
