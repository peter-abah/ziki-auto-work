import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PR_TRACKING, loadProfile, resolveMergeMethod, resolveMergeMode, resolveParityFile, resolveRunLimits } from "./config.js";
import { createLogger, sleep, truncate } from "./log.js";
import { acquireLock, releaseLock, loadState, saveState, writePid, clearPid, isPaused, isStopped, counterFor, setTask, taskKey, pruneState, appendHistory, isAlive } from "./state.js";
import { Mutex } from "./mutex.js";
import { TaskPool } from "./scheduler.js";
import { clientForAgent, normalizeIdea, normalizeIssue } from "./ziki.js";
import { GitHub, branchName, slugify } from "./github.js";
import { formatPrContext } from "./pr-context.js";
import { preparePrBody } from "./pr-body.js";
import { prepareWorktree, prepareReviewWorktree, cleanupWorktree } from "./worktree.js";
import { runWorker, runDiscovery, runReview, runFollowUp, runConfirm, runTriage, runOwner, runEstimate, runInvestigate, runImportance, runStakeVote, runSenseCheck, runClose, runResearch, runJobReview, killActiveAgents } from "./agent.js";
import { killProcessTree } from "./platform/process.js";
import { loadMemoryContext, formatMemoryForPrompt, recordTaskNote } from "./memory.js";
import { escalate, poll } from "./hitl.js";
import { buildQueue, textMatchesPlatform } from "./queue.js";
import { scanSecrets, protectedFiles } from "./checks.js";
import { escalationUrl, inboxUrl } from "./urls.js";
import { notifyProfile } from "./notify.js";
import { isTransientNetworkError } from "./network.js";
import { formatLiveDuration, formatLiveTask, LiveStatus } from "./live-status.js";
import { buildRunSummary, formatRunSummary, writeRunSummary } from "./run-report.js";
import { addUsage, emptyUsage, formatTokens, usagePercent } from "./usage.js";
import { resolveCapacity } from "./capacity.js";
import { mergeGateReason } from "./merge.js";
import { latestDecision, parseOwnerDecisions } from "./decisions.js";
import { formatLoopContext } from "./loop-context.js";
const WORKABLE = new Set(["requires_confirmation", "open", "in_progress"]);
const TERMINAL = new Set(["resolved", "closed"]);
function setPhase(ctx, phase, activity = null) {
    if (ctx.phase === phase && ctx.activity === activity)
        return;
    ctx.phase = phase;
    ctx.activity = activity;
    ctx.phaseStartedAt = new Date().toISOString();
    void writeStatus(ctx).catch(() => { });
}
function renderLive(ctx) {
    const tasks = ctx.pool.list();
    const first = tasks[0];
    const activity = first
        ? `${formatLiveTask(first)}${tasks.length > 1 ? ` +${tasks.length - 1}` : ""}`
        : ctx.activity ?? ctx.phase;
    const started = ctx.state.run.startedAt ? new Date(ctx.state.run.startedAt).getTime() : Date.now();
    const elapsed = formatLiveDuration(Date.now() - started);
    const limit = ctx.runLimits.maxRuntimeMinutes
        ? formatLiveDuration(ctx.runLimits.maxRuntimeMinutes * 60 * 1000)
        : "∞";
    const needs = Object.values(ctx.state.escalations).filter((escalation) => escalation.status === "open").length;
    const tokens = ctx.state.run.tokens;
    const tokenText = `tokens ${formatTokens(tokens.total)}${tokens.estimated ? " est" : ""}`;
    return {
        line: `${ctx.profileName} · ${activity} · ${elapsed}/${limit} · Ziki:${needs} · ${tokenText}`,
        key: `${ctx.phase}|${first?.key ?? ""}|${first?.label ?? ""}|${first?.kind ?? ""}|${tasks.length}|${needs}`
    };
}
function prTracking(profile) {
    return { ...DEFAULT_PR_TRACKING, ...(profile.prTracking ?? {}) };
}
function prTaskKey(task) {
    return `pr:${task.prUrl ?? task.number ?? "unknown"}`;
}
function taskLabel(entry) {
    const target = entry.issueNumber != null ? `#${entry.issueNumber}` : entry.ideaNumber != null ? `#${entry.ideaNumber}` : "";
    const title = truncate(entry.title ?? "", 40);
    const kind = entry.kind === "ready_issue" || entry.kind === "active_claim" || entry.kind === "offer" ? "" : entry.kind.replace(/_/g, " ");
    if (entry.kind === "report_deployment" || entry.kind === "report_pr_status") {
        return `${target} ${entry.kind.replace(/_/g, " ")}`.trim();
    }
    return [target, title || kind].filter(Boolean).join(" ").trim() || entry.key;
}
function kindLabel(entry, kind) {
    const target = entry.issueNumber != null ? `#${entry.issueNumber}` : entry.ideaNumber != null ? `#${entry.ideaNumber}` : entry.key;
    return `${target} ${kind}`;
}
function followUpLabel(task) {
    const number = task.prNumber ?? (task.prUrl ? task.prUrl.match(/\/pull\/(\d+)/)?.[1] : null) ?? task.number;
    return `PR #${number ?? "?"} followup`;
}
function isoMax(values) {
    const found = values.filter((value) => Boolean(value)).sort();
    return found.at(-1) ?? null;
}
function actionablePrComment(comment) {
    if (!comment.body.trim())
        return false;
    if (/\[bot\]$/i.test(comment.author))
        return false;
    const text = comment.body.trim().toLowerCase();
    if (/^(lgtm|looks good|approved|ship it|nice|thanks|thank you)\b/.test(text))
        return false;
    if (comment.kind === "review" && (comment.path || comment.line))
        return true;
    return /\b(fix|please|should|could you|can you|need|change|remove|add|update|missing|broken|wrong|fail|error|conflict|rebase|test|why)\b/.test(text);
}
function actionablePrComments(task, comments) {
    const cutoff = task.prLastHandledCommentAt ? Date.parse(task.prLastHandledCommentAt) : 0;
    return comments.filter((comment) => {
        if (!actionablePrComment(comment))
            return false;
        const at = Date.parse(comment.createdAt ?? "") || 0;
        return at > (Number.isFinite(cutoff) ? cutoff : 0);
    });
}
function prFollowUpDue(ctx, task, now = Date.now()) {
    const tracking = prTracking(ctx.profile);
    if (!tracking.enabled)
        return false;
    if (task.status !== "delivered" || !task.prUrl)
        return false;
    if (ctx.pool.has(prTaskKey(task)))
        return false;
    if (task.prLastCheckedAt) {
        const last = Date.parse(task.prLastCheckedAt);
        if (Number.isFinite(last) && now - last < tracking.pollMinutes * 60_000)
            return false;
    }
    return true;
}
async function escalatePrFollowUp(ctx, issue, task, reason) {
    const agent = (task.agentName ? clientByName(ctx, task.agentName) : null) ?? pickWorker(ctx) ?? ctx.primary;
    task.lastError = reason;
    const result = await escalate(agent.client, ctx.profile, ctx.profilePaths, ctx.state, {
        issue,
        type: "blocker",
        body: `PR follow-up for #${issue.number} needs a human: ${reason}\n\nPR: ${task.prUrl ?? "(none)"}\nAttempts: ${task.followUpAttempts ?? 0}`,
        agentName: agent.name,
        logger: ctx.logger,
        maxOpen: ctx.profile.limits.maxOpenEscalations
    });
    task.status = result.ok ? "waiting_human" : "failed";
    if (!result.ok)
        task.lastError = `${reason} (escalation failed: ${result.error ?? "unknown"})`;
}
async function processPrFollowUpSafe(ctx, task) {
    try {
        await processPrFollowUp(ctx, task);
    }
    catch (error) {
        task.lastError = error instanceof Error ? error.message : String(error);
        task.prLastCheckedAt = new Date().toISOString();
        ctx.logger.error(`PR follow-up for #${task.number} crashed: ${task.lastError}`);
        history(ctx, { type: "failure", issue: typeof task.number === "number" ? task.number : null, detail: `PR follow-up: ${task.lastError}` });
        await save(ctx).catch(() => { });
    }
}
async function processPrFollowUp(ctx, task) {
    if (!task.prUrl || !task.branch) {
        task.prLastCheckedAt = new Date().toISOString();
        task.lastError = "delivered PR is missing a branch; cannot follow up";
        await save(ctx);
        return;
    }
    const data = await ctx.primary.client.getIssue(String(task.number ?? ""));
    const issue = normalizeIssue(data);
    if (!issue) {
        task.prLastCheckedAt = new Date().toISOString();
        task.lastError = "could not load the issue for PR follow-up";
        await save(ctx);
        return;
    }
    const status = await ctx.github.prStatus(task.prUrl);
    task.prNumber = status.number ?? task.prNumber;
    task.prState = status.merged ? "merged" : status.state;
    task.prChecks = status.checks;
    task.prMergeable = status.mergeable;
    task.prReviewDecision = status.reviewDecision;
    task.prLastCheckedAt = new Date().toISOString();
    task.headSha = status.headSha ?? task.headSha;
    if (status.merged || status.state === "CLOSED") {
        task.status = status.merged ? "done" : "skipped";
        task.reason = status.merged ? `PR merged into ${status.mergedInto ?? "base"}` : "PR closed without merge";
        history(ctx, { type: status.merged ? "delivery" : "failure", issue: issue.number, detail: task.reason, data: { pr: task.prUrl } });
        await save(ctx);
        return;
    }
    const reviewComments = (await ctx.github.prReviewComments(task.prUrl).catch(() => []))
        .map((comment) => ({ ...comment, kind: "review" }));
    const allComments = new Map();
    for (const comment of [...status.comments, ...reviewComments])
        allComments.set(comment.id, comment);
    const comments = actionablePrComments(task, [...allComments.values()]);
    const tracking = prTracking(ctx.profile);
    const failing = tracking.fixFailingChecks && status.checks === "failing";
    const newComments = tracking.fixReviewComments && comments.length > 0;
    const changesRequested = tracking.fixReviewComments &&
        status.reviewDecision === "CHANGES_REQUESTED" &&
        status.reviewDecision !== task.prLastHandledReviewDecision;
    const conflict = status.mergeable === false;
    if (!failing && !newComments && !changesRequested && !conflict) {
        await save(ctx);
        return;
    }
    const maxAttempts = tracking.maxFollowUps;
    if ((task.followUpAttempts ?? 0) >= maxAttempts) {
        await escalatePrFollowUp(ctx, issue, task, `follow-up limit reached (${maxAttempts})`);
        await save(ctx);
        return;
    }
    if (!task.worktree || !existsSync(task.worktree)) {
        await escalatePrFollowUp(ctx, issue, task, "the delivered worktree is missing; cannot push follow-up commits");
        await save(ctx);
        return;
    }
    const agent = (task.agentName ? clientByName(ctx, task.agentName) : null) ?? pickWorker(ctx);
    if (!agent) {
        await escalatePrFollowUp(ctx, issue, task, "no worker agent available for PR follow-up");
        await save(ctx);
        return;
    }
    const checkLogs = failing ? await ctx.github.failedCheckLogs(status).catch(() => []) : [];
    const prContext = formatPrContext(status, [...allComments.values()].filter((comment) => comment.kind === "review"), checkLogs);
    const previousError = task.lastError ?? "";
    const attempt = (task.followUpAttempts ?? 0) + 1;
    task.followUpAttempts = attempt;
    task.lastFollowUpAt = new Date().toISOString();
    task.lastError = null;
    await save(ctx);
    const heartbeat = setInterval(() => {
        agent.client.heartbeat(issue.id).catch(() => { });
    }, 10 * 60 * 1000);
    let result;
    try {
        result = await runFollowUp({
            profile: ctx.profile,
            profilePaths: ctx.profilePaths,
            issue,
            memoryText: ctx.memoryText,
            worktree: task.worktree,
            branch: task.branch,
            base: ctx.profile.repo.base,
            prUrl: task.prUrl,
            prContext,
            attempt,
            maxAttempts,
            previousError,
            loopContext: await loopContextFor(ctx, { issue, worktree: task.worktree ?? null }),
            logger: ctx.logger,
            ...agentHooks(ctx)
        });
    }
    finally {
        clearInterval(heartbeat);
    }
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        await save(ctx);
        return;
    }
    if (!result.ok) {
        const reason = result.error ?? result.blocker ?? result.summary ?? "follow-up agent failed";
        task.lastError = reason;
        if (result.blocked || attempt >= maxAttempts) {
            await escalatePrFollowUp(ctx, issue, task, reason);
        }
        await save(ctx);
        return;
    }
    await ctx.github.git(["add", "-A"], { cwd: task.worktree });
    const changed = await ctx.github.stagedChangedFiles(task.worktree, "HEAD");
    if (!changed.length) {
        const reason = "follow-up produced no changes";
        task.lastError = reason;
        if (attempt >= maxAttempts)
            await escalatePrFollowUp(ctx, issue, task, reason);
        await save(ctx);
        return;
    }
    if (changed.length > ctx.profile.workflow.maxFiles) {
        await escalatePrFollowUp(ctx, issue, task, `follow-up touches ${changed.length} files (max ${ctx.profile.workflow.maxFiles})`);
        await save(ctx);
        return;
    }
    const diffStats = await ctx.github.diffStats(task.worktree, "HEAD").catch(() => ({ files: 0, insertions: 0, deletions: 0, total: 0 }));
    if (diffStats.total > ctx.profile.workflow.maxLines) {
        await escalatePrFollowUp(ctx, issue, task, `follow-up is ${diffStats.total} lines (max ${ctx.profile.workflow.maxLines})`);
        await save(ctx);
        return;
    }
    const protectedHits = protectedFiles(changed, ctx.profile.repo.protectedFiles);
    if (protectedHits.length) {
        await escalatePrFollowUp(ctx, issue, task, `protected files changed: ${protectedHits.join(", ")}`);
        await save(ctx);
        return;
    }
    const diff = await ctx.github.git(["diff", "--cached", "HEAD"], { cwd: task.worktree })
        .then((output) => output.stdout)
        .catch(() => "");
    const secretHits = scanSecrets(diff);
    if (secretHits.length) {
        await escalatePrFollowUp(ctx, issue, task, `possible secret in follow-up: ${secretHits[0]}`);
        await save(ctx);
        return;
    }
    const message = normalizeCommitMessage(result.commitMessage, issue, ctx.profile.workflow.commitTypes);
    const commit = await ctx.github.commitAll(task.worktree, message);
    if (!commit.committed) {
        await escalatePrFollowUp(ctx, issue, task, "nothing to commit after follow-up");
        await save(ctx);
        return;
    }
    await ctx.github.pushBranch(task.worktree, task.branch, { force: status.mergeable === false });
    if (result.prBody) {
        const prepared = await preparePrBody({
            profile: ctx.profile,
            issue,
            result,
            fallback: {
                issue,
                summary: result.summary ?? `Follow-up for #${issue.number}`,
                description: result.description ?? "",
                testResults: result.testResults ?? "",
                checks: result.checks ?? []
            }
        }).catch(() => null);
        if (prepared?.source === "agent")
            await ctx.github.updatePrBody(task.prUrl, prepared.body).catch(() => { });
    }
    task.status = "delivered";
    task.headSha = await ctx.github.headSha(task.worktree).catch(() => commit.sha);
    task.prLastHandledHeadSha = status.headSha;
    task.prLastHandledCommentAt =
        isoMax(comments.map((comment) => comment.createdAt)) ??
            (comments.length ? new Date().toISOString() : task.prLastHandledCommentAt ?? null);
    task.prLastHandledReviewDecision = status.reviewDecision ?? task.prLastHandledReviewDecision ?? null;
    task.prLastCheckedAt = new Date().toISOString();
    task.deliveredAt = new Date().toISOString();
    task.lastError = null;
    history(ctx, {
        type: "delivery",
        issue: issue.number,
        detail: `follow-up ${attempt} ${agent.name}`,
        data: { pr: task.prUrl, files: changed.length, headSha: task.headSha }
    });
    ctx.logger.info(`PR follow-up for #${issue.number} pushed`, { attempt, files: changed.length, pr: task.prUrl });
    await save(ctx);
}
async function requeueCrashedTask(ctx, item, error) {
    const message = truncate(error instanceof Error ? error.message : String(error), 500);
    const task = Object.values(ctx.state.tasks).find((entry) => String(entry.number) === String(item.issueNumber));
    if (!task || !["claimed", "working"].includes(task.status))
        return false;
    const maxAttempts = ctx.profile.limits.maxAttemptsPerTask ?? 3;
    if (task.attempts >= maxAttempts) {
        task.status = "failed";
        task.lastError = message;
        return false;
    }
    task.status = "queued";
    task.lastError = message;
    return true;
}
function isOurAgent(ctx, name) {
    if (!name)
        return false;
    return [...ctx.clients.workers, ...ctx.clients.managers].some((agent) => agent.name === name);
}
function clientByName(ctx, name) {
    if (!name)
        return null;
    return [...ctx.clients.workers, ...ctx.clients.managers].find((agent) => agent.name === name) ?? null;
}
function agentForItem(ctx, item) {
    return clientByName(ctx, item.item._feedAgent) ?? ctx.primary;
}
function activeClaims(ctx) {
    return Object.values(ctx.state.tasks).filter((task) => ["claimed", "working"].includes(task.status));
}
function pickWorker(ctx, exclude = []) {
    const excluded = new Set(exclude.filter(Boolean));
    return (ctx.clients.workers.find((agent) => !excluded.has(agent.name)) ??
        ctx.clients.managers.find((agent) => !excluded.has(agent.name)) ??
        null);
}
function pickManager(ctx, exclude = []) {
    const excluded = new Set(exclude.filter(Boolean));
    return ctx.clients.managers.find((agent) => !excluded.has(agent.name)) ?? null;
}
function pickManagerOrWorker(ctx, exclude = []) {
    return pickManager(ctx, exclude) ?? pickWorker(ctx, exclude);
}
function pickAvailableWorker(ctx) {
    const busy = new Set(Object.values(ctx.state.tasks)
        .filter((task) => ["claimed", "working"].includes(task.status))
        .map((task) => task.agentName)
        .filter((name) => Boolean(name)));
    const pool = ctx.clients.workers.length ? ctx.clients.workers : ctx.clients.managers;
    return pool.find((agent) => !busy.has(agent.name) && !ctx.reservedAgents.has(agent.name)) ?? null;
}
function agentHooks(ctx) {
    return {
        onSpawn: (pid) => {
            ctx.state.activePids = [...new Set([...ctx.state.activePids, pid])];
            void save(ctx).catch(() => { });
        },
        onExit: (pid) => {
            ctx.state.activePids = ctx.state.activePids.filter((value) => value !== pid);
            void save(ctx).catch(() => { });
        }
    };
}
function counter(ctx) {
    return counterFor(ctx.state);
}
function markRecent(ctx, key) {
    ctx.state.recentFeedKeys[key] = Date.now();
}
function history(ctx, entry) {
    void appendHistory(ctx.profilePaths, { at: new Date().toISOString(), ...entry }).catch(() => { });
}
function taskUsage(ctx, issue, usage) {
    if (!usage)
        return;
    ctx.state.run.tokens = addUsage(ctx.state.run.tokens, usage);
    if (issue) {
        const task = ctx.state.tasks[taskKey(issue)];
        if (task)
            task.tokens = addUsage(task.tokens ?? emptyUsage(), usage);
    }
    const limit = ctx.profile.limits.maxTokensPerRun ?? null;
    const percent = usagePercent(ctx.state.run.tokens.total, limit);
    if (limit !== null && ctx.state.run.tokens.total >= limit && !ctx.tokenLimitReached) {
        ctx.tokenLimitReached = true;
        ctx.logger.warn(`Token limit reached: ${formatTokens(ctx.state.run.tokens.total)}/${formatTokens(limit)}`);
        void notifyProfile(ctx.profile, "auto-work: token limit reached", `Used ${formatTokens(ctx.state.run.tokens.total)} of ${formatTokens(limit)} tokens. The loop will stop after the current task.`, ctx.logger);
    }
    else if (percent !== null && percent >= (ctx.profile.limits.tokenWarnPercent ?? 80) && !ctx.tokenWarned) {
        ctx.tokenWarned = true;
        ctx.logger.warn(`Token warning: ${percent}% of the run budget used`);
        void notifyProfile(ctx.profile, "auto-work: token budget warning", `${percent}% used (${formatTokens(ctx.state.run.tokens.total)}/${formatTokens(limit)}).`, ctx.logger);
    }
}
async function handleProviderLimit(ctx, result) {
    if (!result.providerLimit) {
        ctx.rateLimitCount = 0;
        return false;
    }
    if (result.providerLimit === "quota") {
        ctx.providerLimit = "quota";
        if (!ctx.providerLimitNotified) {
            ctx.providerLimitNotified = true;
            await notifyProfile(ctx.profile, "auto-work: provider quota exhausted", "The provider account has no quota/credits left. The loop will stop after the current cycle.", ctx.logger);
        }
        return true;
    }
    if (result.providerLimit === "rate-limit") {
        const minutes = ctx.profile.limits.providerRetryMinutes ?? 15;
        ctx.rateLimitCount += 1;
        ctx.rateLimitUntil = Date.now() + minutes * 60 * 1000;
        ctx.logger.warn(`Provider rate limit hit; backing off ${minutes} minutes (${ctx.rateLimitCount}/3)`);
        if (ctx.rateLimitCount >= 3) {
            ctx.providerLimit = "quota";
            if (!ctx.providerLimitNotified) {
                ctx.providerLimitNotified = true;
                await notifyProfile(ctx.profile, "auto-work: provider rate limit repeated", "Stopping after three consecutive rate limits.", ctx.logger);
            }
        }
        return true;
    }
    return false;
}
async function notifyNeedsYou(ctx) {
    const open = Object.values(ctx.state.escalations).filter((escalation) => escalation.status === "open");
    const count = open.length;
    if (ctx.lastNeedsYouCount === count)
        return;
    if (ctx.lastNeedsYouCount === null && count === 0) {
        ctx.lastNeedsYouCount = 0;
        return;
    }
    const link = inboxUrl(ctx.profile);
    const title = count ? `auto-work: ${count} item${count === 1 ? "" : "s"} need you on Ziki` : "auto-work: Ziki is clear";
    const body = count ? `Open Ziki to handle them: ${link}` : "Nothing is waiting on you.";
    await notifyProfile(ctx.profile, title, body, ctx.logger);
    ctx.lastNeedsYouCount = count;
}
function fileEvidence(files) {
    return (files ?? []).map((file) => (typeof file === "string" ? { path: file } : file));
}
export function normalizeCommitMessage(message, issue, commitTypes) {
    const types = commitTypes.length ? commitTypes : ["fix"];
    const fallbackType = types.includes("fix") ? "fix" : types[0];
    const fallback = `${fallbackType}(${issue.number}): ${issue.title}`.slice(0, 72);
    if (!message)
        return fallback;
    const text = String(message).split("\n")[0].trim();
    const pattern = new RegExp(`^(${types.map((type) => type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\([^)]+\\): \\S`);
    if (!pattern.test(text))
        return fallback;
    return text.length > 72 ? text.slice(0, 72) : text;
}
const ENV_FAILURE_PATTERNS = [
    { pattern: /command not found/i, label: "a required command is not on PATH" },
    { pattern: /\bENOENT\b/i, label: "a required file or command is missing" },
    { pattern: /missing (env|environment|variable|token|key)/i, label: "a required environment value is missing" },
    { pattern: /environment variable .* (not set|missing)/i, label: "a required environment variable is not set" },
    { pattern: /(401|403|unauthorized|forbidden|not authenticated|not logged in|no credentials)/i, label: "authentication or permission is missing" },
    { pattern: /\.env/i, label: "a project .env value is missing" },
    { pattern: /(flutter|dart|node|npm|go|cargo|gh|git):? not found/i, label: "a toolchain executable is missing" }
];
function classifyEnvironmentFailure(text) {
    if (!text)
        return null;
    for (const entry of ENV_FAILURE_PATTERNS) {
        if (entry.pattern.test(text))
            return entry.label;
    }
    return null;
}
function remainingMs(ctx) {
    const limits = ctx.runLimits;
    const started = ctx.state.run.startedAt ? new Date(ctx.state.run.startedAt).getTime() : Date.now();
    const deadlines = [];
    if (limits.maxRuntimeMinutes !== null) {
        deadlines.push(started + limits.maxRuntimeMinutes * 60 * 1000 - Date.now());
    }
    if (limits.stopAt) {
        const at = new Date(limits.stopAt).getTime();
        if (Number.isFinite(at))
            deadlines.push(at - Date.now());
    }
    if (!deadlines.length)
        return null;
    return Math.max(0, Math.min(...deadlines));
}
async function loopContextFor(ctx, options = {}) {
    const issue = options.issue ?? null;
    let pr = options.prStatus ?? null;
    let reviewComments = [];
    let checkLogs = [];
    if (!pr && issue?.pullRequestUrl) {
        pr = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
    }
    if (pr) {
        reviewComments = (await ctx.github.prReviewComments(pr.url).catch(() => []))
            .map((comment) => ({ ...comment, kind: "review" }));
        checkLogs = await ctx.github.failedCheckLogs(pr).catch(() => []);
    }
    let git = null;
    const worktree = options.worktree ?? (issue ? ctx.state.tasks[taskKey(issue)]?.worktree : null);
    if (options.includeGit !== false && worktree && existsSync(worktree)) {
        const branch = await ctx.github.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree }).then((out) => out.stdout).catch(() => null);
        const headSha = await ctx.github.headSha(worktree).catch(() => null);
        const baseSha = await ctx.github.baseSha().catch(() => null);
        const counts = await ctx.github
            .git(["rev-list", "--left-right", "--count", `upstream/${ctx.profile.repo.base}...HEAD`], { cwd: worktree })
            .then((out) => out.stdout.trim().split(/\s+/).map(Number))
            .catch(() => []);
        const conflicts = await ctx.github.git(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree })
            .then((out) => Boolean(out.stdout.trim()))
            .catch(() => null);
        const diff = await ctx.github.diffStats(worktree).catch(() => null);
        const files = await ctx.github.changedFiles(worktree).catch(() => []);
        git = {
            branch,
            base: ctx.profile.repo.base,
            baseSha,
            headSha,
            behind: Number.isFinite(counts[0]) ? counts[0] : null,
            ahead: Number.isFinite(counts[1]) ? counts[1] : null,
            conflicts,
            files,
            diff
        };
    }
    const task = issue ? ctx.state.tasks[taskKey(issue)] ?? null : null;
    const decisions = parseOwnerDecisions(issue?.comments);
    const started = ctx.state.run.startedAt ? new Date(ctx.state.run.startedAt).getTime() : Date.now();
    const available = (ctx.queue?.all ?? []).slice(0, 8).map((entry) => `${entry.kind} #${entry.issueNumber ?? entry.ideaNumber ?? "?"} ${truncate(entry.title, 80)}`);
    const blocked = [
        ...Object.values(ctx.state.tasks)
            .filter((entry) => entry.status === "waiting_human" || entry.status === "failed")
            .slice(0, 8)
            .map((entry) => `#${entry.number} ${entry.status}: ${entry.lastError ?? entry.reason ?? "no reason recorded"}`),
        ...[...ctx.unsupportedKinds].map((kind) => `${kind}: unsupported by this build`)
    ];
    const changedSinceLastLoop = task
        ? `task updated ${task.updatedAt}; PR checked ${task.prLastCheckedAt ?? "never"}; follow-ups ${task.followUpAttempts ?? 0}`
        : null;
    return formatLoopContext({
        issue,
        idea: options.idea ?? null,
        task,
        pr,
        checkLogs,
        reviewComments,
        git,
        ownerDecisions: decisions,
        workflow: {
            pushMode: ctx.profile.repo.pushMode ?? "inferred",
            target: ctx.profile.repo.githubRepo,
            fork: ctx.profile.repo.forkOwner,
            base: ctx.profile.repo.base,
            teamLead: ctx.profile.pr.teamLead || ctx.profile.repo.teamLead || null,
            protectedFiles: ctx.profile.repo.protectedFiles ?? [],
            requiredLabels: ctx.profile.repo.requiredLabels ?? [],
            requiredReviewers: ctx.profile.repo.requiredReviewers ?? [],
            mergeMode: resolveMergeMode(ctx.profile),
            mergeMethod: resolveMergeMethod(ctx.profile),
            maxFiles: ctx.profile.workflow.maxFiles,
            maxLines: ctx.profile.workflow.maxLines
        },
        budgets: {
            elapsed: formatLiveDuration(Date.now() - started),
            remaining: formatLiveDuration(remainingMs(ctx)),
            tokens: formatTokens(ctx.state.run.tokens.total),
            attempt: task?.attempts ?? 0,
            attemptLimit: ctx.profile.limits.maxAttemptsPerTask
        },
        available,
        blocked,
        changedSinceLastLoop
    });
}
async function buildStatus(ctx, extra = {}) {
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
        phase: ctx.phase,
        phaseStartedAt: ctx.phaseStartedAt,
        activity: ctx.activity,
        queue: ctx.queue?.counts ?? null,
        capacity: ctx.capacity,
        profileLimits: ctx.profile.limits,
        unsupportedKinds: [...ctx.unsupportedKinds],
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
            prState: task.prState ?? null,
            prChecks: task.prChecks ?? null,
            prMergeable: task.prMergeable ?? null,
            reviewDecision: task.prReviewDecision ?? null,
            followUpAttempts: task.followUpAttempts ?? 0,
            lastFollowUpAt: task.lastFollowUpAt ?? null,
            prLastCheckedAt: task.prLastCheckedAt ?? null,
            agent: task.agentName ?? null,
            tokens: task.tokens?.total ?? null,
            lastError: task.lastError ?? null,
            updatedAt: task.updatedAt
        })),
        counters: counter(ctx),
        escalations: open.map((escalation) => ({
            id: escalation.id,
            issue: escalation.issueNumber,
            type: escalation.type,
            body: truncate(escalation.body, 300),
            createdAt: escalation.createdAt,
            link: escalationUrl(ctx.profile, escalation.issueNumber)
        })),
        needsYou: {
            count: open.length,
            link: open.length ? inboxUrl(ctx.profile) : inboxUrl(ctx.profile),
            latest: open[0]
                ? {
                    id: open[0].id,
                    issue: open[0].issueNumber,
                    type: open[0].type,
                    body: truncate(open[0].body, 300),
                    createdAt: open[0].createdAt,
                    link: escalationUrl(ctx.profile, open[0].issueNumber)
                }
                : null
        },
        run: {
            limits: ctx.runLimits,
            startedAt: ctx.state.run.startedAt,
            elapsedMs: started ? Date.now() - started : null,
            remainingMs: remainingMs(ctx),
            remainingCycles: ctx.runLimits.maxCycles === null ? null : Math.max(0, ctx.runLimits.maxCycles - ctx.state.cycles),
            remainingDeliveries: ctx.runLimits.maxDeliveriesTotal === null
                ? null
                : Math.max(0, ctx.runLimits.maxDeliveriesTotal - ctx.state.run.deliveries),
            deliveries: ctx.state.run.deliveries,
            failures: ctx.state.run.failures,
            networkErrors: ctx.state.run.networkErrors ?? 0,
            stopReason: ctx.state.run.stopReason
        },
        tokens: {
            ...ctx.state.run.tokens,
            limit: ctx.profile.limits.maxTokensPerRun ?? null,
            percent: usagePercent(ctx.state.run.tokens.total, ctx.profile.limits.maxTokensPerRun ?? null),
            warnPercent: ctx.profile.limits.tokenWarnPercent ?? 80
        },
        inFlight: {
            total: ctx.pool.total(),
            deliveries: ctx.pool.count("delivery"),
            followUps: ctx.pool.count("followup"),
            reviews: ctx.pool.count("review"),
            aux: ctx.pool.count("aux"),
            discovery: ctx.pool.count("discovery"),
            owner: ctx.pool.count("owner"),
            tasks: ctx.pool.list()
        },
        lastCycle: ctx.state.lastCycle,
        lastRun: ctx.state.lastRun,
        memoryLoadedAt: ctx.memory?.loadedAt ?? null,
        repoReady: ctx.repoReady,
        lastError: ctx.state.lastError,
        ...extra
    };
}
async function writeStatus(ctx, extra = {}) {
    const status = await buildStatus(ctx, extra);
    await ctx.mutex.run(async () => {
        await mkdir(ctx.profilePaths.stateDir, { recursive: true });
        await writeFile(ctx.profilePaths.statusFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    });
}
async function save(ctx) {
    if (ctx.state.lastCycleAt) {
        ctx.state.lastCycle = {
            at: ctx.state.lastCycleAt,
            ms: ctx.state.lastCycleMs ?? 0,
            queue: ctx.queue?.counts ?? ctx.state.lastCycle?.queue ?? null,
            ...ctx.cycleStats
        };
    }
    if (ctx.state.run.startedAt && !ctx.state.lastRun?.clean) {
        ctx.state.lastRun = buildRunSummary({
            state: ctx.state,
            profileName: ctx.profileName,
            profile: ctx.profile,
            clean: false,
            stopReason: null
        });
    }
    await ctx.mutex.run(async () => {
        await saveState(ctx.profilePaths, ctx.state);
        const status = await buildStatus(ctx);
        await mkdir(ctx.profilePaths.stateDir, { recursive: true });
        await writeFile(ctx.profilePaths.statusFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    });
}
async function fetchMergedFeed(ctx) {
    const agents = [ctx.clients.workers[0], ctx.clients.managers[0]].filter(Boolean);
    if (!agents.length)
        return null;
    const merged = new Map();
    let base = null;
    for (const agent of agents) {
        try {
            const etag = ctx.state.feedEtags[agent.name];
            let result = await agent.client.work({ etag });
            if (result.notModified) {
                const cached = ctx.feedCache[agent.name];
                if (cached) {
                    result = { notModified: false, data: cached, etag: result.etag ?? etag };
                }
                else {
                    result = await agent.client.work({});
                }
            }
            if (!result.data)
                continue;
            ctx.feedCache[agent.name] = result.data;
            if (!base)
                base = result.data;
            for (const item of result.data.items ?? []) {
                item._feedAgent = agent.name;
                const previous = merged.get(item.key);
                if (!previous || (item.actions?.length ?? 0) > (previous.actions?.length ?? 0)) {
                    merged.set(item.key, item);
                }
            }
            if (result.etag)
                ctx.state.feedEtags[agent.name] = result.etag;
        }
        catch (error) {
            ctx.logger.warn(`Work feed failed for ${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!base)
        return null;
    return { ...base, items: [...merged.values()] };
}
async function loadPlatformSets(ctx) {
    const file = ctx.profilePaths.desktopCacheFile;
    let cached = null;
    if (existsSync(file)) {
        try {
            cached = JSON.parse(await readFile(file, "utf8"));
        }
        catch {
            cached = null;
        }
    }
    if (cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < 10 * 60 * 1000) {
        return cached;
    }
    try {
        const [issues, ideas] = await Promise.all([
            ctx.primary.client.listAllIssues({ platform: ctx.profile.ziki.platform, max: 2000 }),
            ctx.primary.client.listAllIdeas({ platform: ctx.profile.ziki.platform, max: 1000 })
        ]);
        const data = {
            fetchedAt: new Date().toISOString(),
            issues: issues.map((issue) => ({
                id: issue.id,
                number: issue.number,
                title: issue.title,
                status: issue.status,
                substatus: issue.substatus
            })),
            ideas: ideas.map((idea) => ({ id: idea.id, number: idea.number, title: idea.title, status: idea.status }))
        };
        await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        return data;
    }
    catch (error) {
        ctx.logger.warn(`Platform set refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        return cached ?? { fetchedAt: null, issues: [], ideas: [] };
    }
}
async function heartbeatPass(ctx) {
    const now = Date.now();
    const live = Object.values(ctx.state.tasks).filter((task) => ["claimed", "working", "waiting_human"].includes(task.status));
    for (const task of live) {
        if (!task.agentName || !task.id)
            continue;
        const last = task.lastHeartbeatAt ? new Date(task.lastHeartbeatAt).getTime() : 0;
        if (now - last < 10 * 60 * 1000)
            continue;
        const agent = clientByName(ctx, task.agentName);
        if (!agent)
            continue;
        try {
            await agent.client.heartbeat(task.id);
            task.lastHeartbeatAt = new Date().toISOString();
            ctx.logger.info(`Heartbeat #${task.number}`, { agent: agent.name });
        }
        catch (error) {
            ctx.logger.warn(`Heartbeat failed for #${task.number}: ${error instanceof Error ? error.message : String(error)}`);
            if ([409, 410].includes(error.status ?? 0) && task.status !== "waiting_human") {
                task.status = "queued";
                task.claimId = undefined;
                task.lastError = "claim lost";
            }
        }
    }
}
async function withScratch(ctx, label, fn) {
    const dir = path.join(ctx.profilePaths.worktreesDir, `scratch-${slugify(label, 60)}`);
    await ctx.github.createScratchWorktree(dir);
    try {
        return await fn(dir);
    }
    finally {
        await cleanupWorktree(ctx.github, dir);
    }
}
async function processOwnerItem(ctx, item) {
    const requestId = String(item.key).split(":")[1] ?? "";
    const agent = clientByName(ctx, item.item._feedAgent) ?? ctx.primary;
    const request = { id: requestId, body: item.detail };
    ctx.logger.info(`Owner request ${requestId}: ${truncate(request.body, 160)}`);
    const result = await withScratch(ctx, `owner-${requestId}`, (dir) => runOwner({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        request,
        memoryText: ctx.memoryText,
        repoDir: dir,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, null, result.tokens);
    if (await handleProviderLimit(ctx, result))
        return;
    if (result.ok) {
        try {
            await agent.client.completeOwnerRequest(requestId);
        }
        catch (error) {
            ctx.logger.warn(`Could not mark owner request ${requestId} done: ${error instanceof Error ? error.message : String(error)}`);
        }
        await writeOwnerResult(ctx, requestId, request.body, result);
        await recordTaskNote(agent.client, { id: requestId, number: "owner", title: "Owner request" }, "owner_request", result.summary, result.description, ctx.state, agent.name);
    }
    else {
        ctx.logger.warn(`Owner request ${requestId} failed: ${result.error ?? result.blocker ?? "unknown"}`);
    }
    markRecent(ctx, item.key);
    await save(ctx);
}
async function writeOwnerResult(ctx, requestId, request, result) {
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
async function processWorkItem(ctx, item, preferredWorker) {
    if (item.kind === "review_offer") {
        await processReviewOffer(ctx, item);
        return;
    }
    if (item.kind === "job_review_offer") {
        await processJobReviewOffer(ctx, item);
        return;
    }
    if (item.kind === "open_issue") {
        await processOpenIssue(ctx, item);
        return;
    }
    if (item.kind === "reclaim_issue") {
        await processReclaim(ctx, item);
        return;
    }
    const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
    const issue = normalizeIssue(data);
    if (!issue)
        return;
    const existingTask = ctx.state.tasks[taskKey(issue)] ?? null;
    const terminalStatus = TERMINAL.has(issue.status) || ["done", "merge", "accepted"].includes(issue.status) || ["done", "merge"].includes(issue.substatus);
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
            }
            else {
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
            if (recovered)
                await save(ctx);
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
    const branch = branchName(issue, issue.title, ctx.profile.workflow.branchPrefix);
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
        .slice(-20)
        .map((comment) => `- ${comment.authorName ?? comment.by ?? "someone"}: ${comment.body}`)
        .join("\n");
    const issueContext = [issue.pullRequestUrl ? `Linked PR: ${issue.pullRequestUrl}` : "", comments ? `Recent comments:\n${comments}` : ""]
        .filter(Boolean)
        .join("\n\n") || "(none)";
    const heartbeat = setInterval(() => {
        worker.client.heartbeat(issue.id).catch(() => { });
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
            loopContext: await loopContextFor(ctx, { issue, worktree: dir }),
            attempt: ctx.state.tasks[taskKey(issue)]?.attempts ?? 1,
            logger: ctx.logger,
            ...agentHooks(ctx)
        });
    }
    finally {
        clearInterval(heartbeat);
    }
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        await cleanupWorktree(ctx.github, dir);
        setTask(ctx.state, issue, { status: "queued", lastError: result.error ?? "provider limit", worktree: undefined });
        markRecent(ctx, item.key);
        await save(ctx);
        return;
    }
    if (!result.ok) {
        await handleWorkFailure(ctx, issue, item, result, worker, dir);
        return;
    }
    await ctx.github.git(["add", "-A"], { cwd: dir });
    const changed = await ctx.github.stagedChangedFiles(dir);
    if (!changed.length)
        return handleWorkFailure(ctx, issue, item, { error: "agent made no changes" }, worker, dir);
    if (changed.length > ctx.profile.workflow.maxFiles) {
        return handleWorkFailure(ctx, issue, item, { error: `change touches ${changed.length} files (max ${ctx.profile.workflow.maxFiles})` }, worker, dir);
    }
    const diffStats = await ctx.github.diffStats(dir).catch(() => ({ files: 0, insertions: 0, deletions: 0, total: 0 }));
    if (diffStats.total > ctx.profile.workflow.maxLines) {
        return handleWorkFailure(ctx, issue, item, { error: `change is ${diffStats.total} lines (max ${ctx.profile.workflow.maxLines})` }, worker, dir);
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
    const message = normalizeCommitMessage(result.commitMessage, issue, ctx.profile.workflow.commitTypes);
    const commit = await ctx.github.commitAll(dir, message);
    if (!commit.committed) {
        return handleWorkFailure(ctx, issue, item, { error: "nothing to commit" }, worker, dir);
    }
    await ctx.github.pushBranch(dir, branch);
    const preparedBody = await preparePrBody({
        profile: ctx.profile,
        issue,
        result,
        fallback: {
            issue,
            summary: result.summary ?? `Fix #${issue.number}`,
            description: result.description ?? "",
            testResults: result.testResults ?? result.checks?.join("\n") ?? "(not recorded by agent)",
            testedAgainst: result.testedAgainst,
            howToTest: result.howToTest,
            whatToExpect: result.whatToExpect,
            screenshots: (result.screenshots ?? []).filter((screenshot) => /^https?:\/\//.test(screenshot)),
            checks: result.checks ?? [],
            risks: result.risks,
            notes: result.notes
        }
    });
    if (preparedBody.source === "fallback") {
        ctx.logger.warn(`Agent PR body missing or invalid (${preparedBody.reason ?? "unknown"}); using fallback`);
    }
    const body = preparedBody.body;
    const pr = await ctx.github.createPr(branch, message, body);
    const headSha = await ctx.github.headSha(dir);
    await worker.client.deliver(issue.id, {
        pullRequestUrl: pr.url,
        summary: result.summary ?? `Fix #${issue.number}`,
        description: result.description ?? result.summary ?? "",
        testResults: result.testResults ?? result.checks?.join("\n") ?? "(not recorded by agent)",
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
    });
    counter(ctx).deliveries += 1;
    ctx.state.run.deliveries += 1;
    ctx.cycleStats.deliveries += 1;
    history(ctx, { type: "delivery", issue: issue.number, detail: worker.name, data: { pr: pr.url, branch, files: changed.length } });
    markRecent(ctx, item.key);
    await recordTaskNote(worker.client, ctx.state.tasks[taskKey(issue)], "delivered", result.summary, result.description, ctx.state, worker.name);
    ctx.logger.info(`Delivered #${issue.number}`, { pr: pr.url, branch, files: changed.length });
    await save(ctx);
}
async function recoverDelivery(ctx, issue) {
    if (!issue.pullRequestUrl)
        return false;
    const agent = (issue.holder?.agentName ? clientByName(ctx, issue.holder.agentName) : null) ?? pickWorker(ctx);
    if (!agent)
        return false;
    let status = null;
    try {
        status = await ctx.github.prStatus(issue.pullRequestUrl);
    }
    catch (error) {
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
    }
    catch (error) {
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
async function handleWorkFailure(ctx, issue, item, result, worker, dir) {
    const task = ctx.state.tasks[taskKey(issue)];
    const attempts = (task?.attempts ?? 0) + 1;
    const maxAttempts = ctx.profile.limits.maxAttemptsPerTask;
    const error = result.error ?? result.blocker ?? "unknown failure";
    ctx.state.run.failures += 1;
    const environmentHint = classifyEnvironmentFailure(`${error}\n${result.tail ?? ""}`);
    ctx.logger.warn(`#${issue.number} attempt ${attempts} failed: ${truncate(error, 300)}`, {
        environmentHint: environmentHint ?? undefined
    });
    ctx.state.lastError = { at: new Date().toISOString(), issue: issue.number, error: truncate(error, 500) };
    history(ctx, { type: "failure", issue: issue.number, detail: truncate(error, 300), data: { attempts } });
    await cleanupWorktree(ctx.github, dir);
    if (result.blocked || environmentHint || result.providerLimit === "context") {
        const body = result.providerLimit === "context"
            ? `#${issue.number} exceeded the model context window. Split the task or reduce the prompt size. ${result.error ?? ""}`.trim()
            : environmentHint
                ? `#${issue.number} is blocked by the environment: ${environmentHint}. ${result.blocker ?? result.summary ?? error}`
                : `#${issue.number} needs a human: ${result.blocker ?? result.summary ?? error}`;
        const escalation = await escalate(worker.client, ctx.profile, ctx.profilePaths, ctx.state, {
            issue,
            type: "blocker",
            body,
            agentName: worker.name,
            logger: ctx.logger,
            notifyCommand: ctx.profile.hitl.notifyCommand,
            maxOpen: ctx.profile.limits.maxOpenEscalations
        });
        if (escalation.ok) {
            history(ctx, { type: "escalation", issue: issue.number, detail: environmentHint ?? "blocker", data: { id: escalation.escalation?.id } });
            await notifyNeedsYou(ctx);
        }
        if (!escalation.ok) {
            await worker.client.release(issue.id).catch(() => { });
            setTask(ctx.state, issue, {
                status: "queued",
                attempts,
                lastError: escalation.skipped ? `escalation cap reached: ${error}` : error,
                worktree: undefined,
                claimId: undefined
            });
        }
    }
    else if (attempts >= maxAttempts) {
        setTask(ctx.state, issue, { status: "failed", attempts, lastError: error, worktree: undefined });
        await worker.client.release(issue.id).catch(() => { });
        await recordTaskNote(worker.client, issue, "failed", error, result.tail ?? "", ctx.state, worker.name);
        await notifyProfile(ctx.profile, `auto-work: task #${issue.number} failed`, `${truncate(error, 200)}\nauto-work status --verbose`, ctx.logger);
    }
    else {
        setTask(ctx.state, issue, { status: "queued", attempts, lastError: error, worktree: undefined });
    }
    markRecent(ctx, item.key);
    await save(ctx);
}
async function ensureReady(ctx, issue) {
    if (issue.substatus === "requires_confirmation") {
        const confirmer = pickManagerOrWorker(ctx);
        if (!confirmer)
            return false;
        const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
        const result = await withScratch(ctx, `confirm-${issue.number}`, (dir) => runConfirm({
            profile: ctx.profile,
            profilePaths: ctx.profilePaths,
            issue,
            memoryText: ctx.memoryText,
            repoDir: dir,
            loopContext,
            logger: ctx.logger,
            ...agentHooks(ctx)
        }));
        taskUsage(ctx, issue, result.tokens);
        if (await handleProviderLimit(ctx, result))
            return false;
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
                if (escalation.ok) {
                    history(ctx, { type: "escalation", issue: issue.number, detail: "confirmation blocker" });
                    await notifyNeedsYou(ctx);
                }
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
            await confirmer.client.openIssue(issue.id).catch(() => { });
            return true;
        }
        ctx.logger.info(`Confirmation for #${issue.number} still needs weight; not spinning this cycle`);
        markRecent(ctx, `confirm:${issue.id}`);
        return false;
    }
    if (issue.status === "open" || issue.substatus === "open")
        return true;
    return issue.status === "in_progress" || issue.substatus === "in_progress";
}
async function ensureBidAndAward(ctx, issue, preferred) {
    const worker = preferred ?? pickWorker(ctx);
    if (!worker)
        return null;
    const awarder = pickManager(ctx) ?? worker;
    let bids = [];
    try {
        const data = await worker.client.listBids(issue.id);
        bids = data.bids ?? data.items ?? [];
    }
    catch {
        bids = [];
    }
    let bidId = bids.find((bid) => bid.agent_name === worker.name)?.id ?? null;
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
        if (bidId)
            history(ctx, { type: "bid", issue: issue.number, detail: worker.name, data: { bidId } });
    }
    if (!bidId)
        return null;
    let award;
    try {
        award = await awarder.client.awardBid(bidId);
        history(ctx, {
            type: "award",
            issue: issue.number,
            detail: `${awarder.name}${awarder.name === worker.name ? " (self)" : ""}`,
            data: { bidId }
        });
    }
    catch (error) {
        ctx.logger.warn(`Award failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
    const claimId = award.claimId ?? award.claim_id;
    if (!claimId)
        return null;
    try {
        await worker.client.acceptOffer(claimId);
        history(ctx, { type: "accept", issue: issue.number, detail: worker.name, data: { claimId } });
    }
    catch (error) {
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
async function ensureClaim(ctx, issue, preferred) {
    const holder = issue.holder;
    if (holder) {
        const agent = clientByName(ctx, holder.agentName);
        if (!agent)
            return null;
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
            }
            catch (error) {
                ctx.logger.warn(`Could not accept existing offer for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        }
    }
    return ensureBidAndAward(ctx, issue, preferred);
}
async function processTestFix(ctx, item, preferred) {
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
    const reviewer = preferred ?? pickWorker(ctx, [holder ?? ""]) ?? pickManager(ctx, [holder ?? ""]);
    if (!reviewer) {
        markRecent(ctx, item.key);
        return;
    }
    const status = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
    const reviewComments = (await ctx.github.prReviewComments(issue.pullRequestUrl).catch(() => []))
        .map((comment) => ({ ...comment, kind: "review" }));
    const checkLogs = status ? await ctx.github.failedCheckLogs(status).catch(() => []) : [];
    const prContext = status ? formatPrContext(status, reviewComments, checkLogs) : "(PR status unavailable)";
    const issueContext = (issue.comments ?? [])
        .slice(-10)
        .map((comment) => `- ${comment.authorName ?? comment.by ?? "someone"}: ${comment.body}`)
        .join("\n") || "(none)";
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
            prContext,
            issueContext,
            loopContext: await loopContextFor(ctx, { issue, prStatus: status, includeGit: false }),
            logger: ctx.logger,
            ...agentHooks(ctx)
        });
    }
    finally {
        await cleanupWorktree(ctx.github, dir);
    }
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return;
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
    ctx.state.run.reviews += 1;
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
async function processAccept(ctx, item) {
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
    }
    catch {
        good = false;
    }
    let prStatus = null;
    if (issue.pullRequestUrl) {
        try {
            prStatus = await ctx.github.prStatus(issue.pullRequestUrl);
        }
        catch (error) {
            ctx.logger.warn(`PR status failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!good || !prStatus || prStatus.checks === "failing" || prStatus.mergeable === false) {
        if (prStatus && issue.pullRequestUrl) {
            const reporter = pickManager(ctx, [holder ?? ""]) ?? pickWorker(ctx, [holder ?? ""]);
            if (reporter)
                await reportPrStatusWith(ctx, reporter, issue, prStatus).catch(() => { });
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
    ctx.state.run.reviews += 1;
    ctx.state.run.mergeReviews += 1;
    ctx.cycleStats.reviews += 1;
    history(ctx, { type: "merge_review", issue: issue.number, detail: manager.name, data: { verdict: "accept" } });
    markRecent(ctx, item.key);
    ctx.logger.info(`Accepted #${issue.number}`, { manager: manager.name });
    await save(ctx);
}
async function processAuxItem(ctx, item) {
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
            case "report_deployment":
                did = await processDeploymentReport(ctx, item);
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
            case "open_issue":
                did = await processOpenIssue(ctx, item);
                break;
            case "refresh_stake":
                did = await processRefreshStake(ctx, item);
                break;
            case "reclaim_issue":
                did = await processReclaim(ctx, item);
                break;
            case "await_release":
                did = await processAwaitRelease(ctx, item);
                break;
            case "repair_pull_request":
                did = await processRepairPullRequest(ctx, item);
                break;
            case "convert_idea":
                did = await processConvertIdea(ctx, item);
                break;
            case "reject_idea":
                did = await processRejectIdea(ctx, item);
                break;
            case "estimate_reward":
                did = await processEstimate(ctx, item);
                break;
            case "investigate_issue":
                did = await processInvestigate(ctx, item);
                break;
            case "vote_importance":
                did = await processImportance(ctx, item);
                break;
            case "vote_stake":
                did = await processStakeVote(ctx, item);
                break;
            case "sense_check":
                did = await processSenseCheck(ctx, item);
                break;
            case "close_issue":
                did = await processClose(ctx, item);
                break;
            case "research_job":
                did = await processResearchJob(ctx, item);
                break;
            case "review_offer":
                did = await processReviewOffer(ctx, item);
                break;
            case "job_review_offer":
                did = await processJobReviewOffer(ctx, item);
                break;
            default:
                ctx.logger.warn(`Unhandled Ziki work kind "${item.kind}" for #${item.issueNumber ?? item.ideaNumber ?? "?"}; skipping`);
                markRecent(ctx, item.key);
                did = false;
        }
        if (did) {
            counter(ctx).aux += 1;
            ctx.state.run.aux += 1;
            ctx.cycleStats.aux += 1;
            history(ctx, { type: "aux", issue: item.issueNumber, idea: item.ideaNumber, detail: item.kind });
        }
        return did;
    }
    catch (error) {
        ctx.logger.warn(`Aux ${item.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
        counter(ctx).errors += 1;
        ctx.state.run.failures += 1;
        ctx.cycleStats.errors += 1;
        markRecent(ctx, item.key);
        return false;
    }
}
async function processPrReport(ctx, item) {
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
    }
    catch (error) {
        ctx.logger.warn(`PR status failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
        markRecent(ctx, item.key);
        return false;
    }
    await reportPrStatusWith(ctx, reporter, issue, status);
    markRecent(ctx, item.key);
    return true;
}
async function processDeploymentReport(ctx, item) {
    const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
    const issue = normalizeIssue(data);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const text = `${item.title ?? ""}\n${item.detail ?? ""}`;
    const match = text.match(/\b(dev|development|staging|stage|prod|production)\b/i);
    const environment = match
        ? { dev: "dev", development: "dev", staging: "staging", stage: "staging", prod: "prod", production: "prod" }[match[1].toLowerCase()]
        : null;
    if (!environment) {
        ctx.logger.warn(`Deployment report for #${issue.number} has no environment; skipping`);
        markRecent(ctx, item.key);
        return false;
    }
    const reporter = pickManager(ctx) ?? pickWorker(ctx);
    if (!reporter) {
        markRecent(ctx, item.key);
        return false;
    }
    await reporter.client.reportDeployment(issue.id, {
        environment,
        note: `Reported from Ziki work item: ${item.title ?? "deployment"}`
    });
    markRecent(ctx, item.key);
    return true;
}
async function reportPrStatusWith(ctx, reporter, issue, status) {
    const report = {
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
async function isInDefaultBranch(ctx, sha) {
    if (!sha)
        return false;
    try {
        await ctx.github.git(["fetch", "upstream", ctx.profile.repo.defaultBranch]);
        const result = await ctx.github.git(["merge-base", "--is-ancestor", sha, `upstream/${ctx.profile.repo.defaultBranch}`]);
        return result.ok;
    }
    catch {
        return false;
    }
}
async function processBidVote(ctx, item) {
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
    if (!voter)
        return false;
    await voter.client.voteBid(bidId);
    markRecent(ctx, item.key);
    return true;
}
async function processAward(ctx, item) {
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
    if (!manager)
        return false;
    try {
        await manager.client.awardBid(bidId);
    }
    catch (error) {
        ctx.logger.debug(`Award skipped for #${item.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
        markRecent(ctx, item.key);
        return false;
    }
    markRecent(ctx, item.key);
    return true;
}
async function processCommentUpvote(ctx, item) {
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
    if (!voter)
        return false;
    await voter.client.upvoteComment(commentId);
    markRecent(ctx, item.key);
    return true;
}
async function processCategorize(ctx, item) {
    const actor = pickWorker(ctx) ?? pickManager(ctx);
    if (!actor)
        return false;
    let did = 0;
    try {
        const issues = await actor.client.listAllIssues({ platform: "none", max: 100 });
        for (const issue of issues) {
            if (did >= 5)
                break;
            if (!textMatchesPlatform(ctx.profile, `${issue.title} ${issue.summary ?? ""}`))
                continue;
            await actor.client.categorizeIssue(issue.id, {
                platform: ctx.profile.ziki.platform,
                reason: "Title/summary matches this profile's platform."
            });
            did += 1;
        }
        const ideas = await actor.client.listAllIdeas({ platform: "none", max: 100 });
        for (const idea of ideas) {
            if (did >= 5)
                break;
            if (!textMatchesPlatform(ctx.profile, `${idea.title} ${idea.summary ?? ""}`))
                continue;
            await actor.client.categorizeIdea(idea.id, {
                platform: ctx.profile.ziki.platform,
                reason: "Title/summary matches this profile's platform."
            });
            did += 1;
        }
    }
    catch (error) {
        ctx.logger.warn(`Categorize failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    markRecent(ctx, item.key);
    if (did)
        history(ctx, { type: "aux", detail: "categorize", data: { count: did, by: actor.name } });
    return did > 0;
}
async function processIdeaVerdict(ctx, item) {
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
    const result = await withScratch(ctx, `triage-${idea.number}`, (dir) => runTriage({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        idea,
        memoryText: ctx.memoryText,
        repoDir: dir,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, null, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
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
    }
    catch (error) {
        if (error.status === 422 && requestedVotes > 1) {
            await voter.client.giveIdeaVerdict(idea.id, { ...verdictPayload, votes: 1 });
        }
        else {
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
        }
        catch {
            // conversion is best-effort
        }
    }
    markRecent(ctx, item.key);
    return true;
}
async function processConfirm(ctx, item) {
    const data = await ctx.primary.client.getIssue(item.issueId ?? item.issueNumber ?? "");
    const issue = normalizeIssue(data);
    if (!issue || issue.substatus !== "requires_confirmation") {
        markRecent(ctx, item.key);
        return false;
    }
    const confirmer = pickManagerOrWorker(ctx);
    if (!confirmer)
        return false;
    const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
    const result = await withScratch(ctx, `confirm-aux-${issue.number}`, (dir) => runConfirm({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
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
    if (response?.confirmed)
        await confirmer.client.openIssue(issue.id).catch(() => { });
    history(ctx, { type: "aux", issue: issue.number, detail: `confirmation: ${verdict}`, data: { by: confirmer.name } });
    markRecent(ctx, item.key);
    return true;
}
function issueIdFromActions(item) {
    for (const action of item.actions) {
        const match = action.path.match(/\/issues\/([^/]+)\//);
        if (match?.[1])
            return match[1];
    }
    return null;
}
async function loadIssueForItem(ctx, item) {
    const id = item.issueId ?? item.issueNumber ?? issueIdFromActions(item) ?? "";
    if (!id)
        return null;
    const data = await ctx.primary.client.getIssue(id);
    return normalizeIssue(data);
}
function actionId(item, names, pattern) {
    for (const action of item.actions) {
        if (names.length && !names.includes(action.name))
            continue;
        const match = action.path.match(pattern);
        if (match?.[1])
            return match[1];
    }
    return null;
}
function pullRequestUrlFrom(item) {
    const text = `${item.title ?? ""}\n${item.detail ?? ""}`;
    return text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)?.[0] ?? null;
}
async function processOpenIssue(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    await agentForItem(ctx, item).client.openIssue(issue.id);
    history(ctx, { type: "aux", issue: issue.number, detail: "opened issue" });
    markRecent(ctx, item.key);
    return true;
}
async function processRefreshStake(ctx, item) {
    let stakeId = actionId(item, ["refresh_stake"], /stakes\/([^/]+)\/refresh/);
    if (!stakeId && item.issueId) {
        const stakes = await ctx.primary.client.listStakes(item.issueId).catch(() => null);
        stakeId = (stakes?.stakes ?? [])[0]?.id ?? null;
    }
    if (!stakeId) {
        ctx.logger.warn(`refresh_stake item ${item.key} has no stake id; skipping`);
        markRecent(ctx, item.key);
        return false;
    }
    await agentForItem(ctx, item).client.refreshStake(stakeId);
    markRecent(ctx, item.key);
    return true;
}
async function processReclaim(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    await agentForItem(ctx, item).client.reclaim(issue.id);
    history(ctx, { type: "aux", issue: issue.number, detail: "reclaimed stale work" });
    markRecent(ctx, item.key);
    return true;
}
async function processReconcileMerged(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue?.pullRequestUrl) {
        markRecent(ctx, item.key);
        return false;
    }
    const manager = pickManager(ctx, [issue.holder?.agentName ?? ""]) ?? pickManager(ctx);
    if (!manager) {
        markRecent(ctx, item.key);
        return false;
    }
    const status = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
    if (!status) {
        markRecent(ctx, item.key);
        return false;
    }
    await reportPrStatusWith(ctx, manager, issue, status).catch(() => { });
    const inDefault = status.merged ? await isInDefaultBranch(ctx, status.mergeCommitSha) : false;
    if (!status.merged || !inDefault) {
        ctx.logger.info(`#${issue.number} is not merged into the default branch yet; reported instead`);
        markRecent(ctx, item.key);
        return true;
    }
    await manager.client.resolveIssue(issue.id, issue.pullRequestUrl);
    history(ctx, { type: "aux", issue: issue.number, detail: "resolved merged work", data: { pr: issue.pullRequestUrl } });
    markRecent(ctx, item.key);
    return true;
}
async function processAwaitRelease(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue?.pullRequestUrl) {
        markRecent(ctx, item.key);
        return false;
    }
    const reporter = pickManager(ctx, [issue.holder?.agentName ?? ""]) ?? pickWorker(ctx, [issue.holder?.agentName ?? ""]);
    if (!reporter) {
        markRecent(ctx, item.key);
        return false;
    }
    const status = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
    if (!status) {
        markRecent(ctx, item.key);
        return false;
    }
    await reportPrStatusWith(ctx, reporter, issue, status);
    markRecent(ctx, item.key);
    return true;
}
async function processRepairPullRequest(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const manager = pickManager(ctx, [issue.holder?.agentName ?? ""]) ?? pickManager(ctx);
    if (!manager) {
        markRecent(ctx, item.key);
        return false;
    }
    await manager.client.repairPullRequest(issue.id, pullRequestUrlFrom(item) ?? undefined);
    history(ctx, { type: "aux", issue: issue.number, detail: "repaired pull request link" });
    markRecent(ctx, item.key);
    return true;
}
async function processConvertIdea(ctx, item) {
    const data = await ctx.primary.client.getIdea(item.ideaId ?? item.ideaNumber ?? "");
    const idea = normalizeIdea(data);
    if (!idea) {
        markRecent(ctx, item.key);
        return false;
    }
    const convertAction = item.actions.find((action) => action.name === "convert_idea" || /\/convert\b/.test(action.path));
    if (!convertAction) {
        ctx.logger.info(`convert_idea item #${idea.number} has no convert action (threshold-only project); leaving the verdict vote to its own item`);
        markRecent(ctx, item.key);
        return false;
    }
    try {
        await agentForItem(ctx, item).client.convertIdea(idea.id);
        history(ctx, { type: "aux", idea: idea.number, detail: "converted idea" });
        markRecent(ctx, item.key);
        return true;
    }
    catch (error) {
        const status = error.status;
        ctx.logger.info(`Idea #${idea.number} not converted: ${error instanceof Error ? error.message : String(error)}`, { status });
        markRecent(ctx, item.key);
        return false;
    }
}
async function processRejectIdea(ctx, item) {
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
    const verdicts = await manager.client.ideaVerdicts(idea.id).catch(() => null);
    if (verdicts && verdicts.rejectable === false) {
        ctx.logger.info(`Idea #${idea.number} is not rejectable; leaving it`);
        markRecent(ctx, item.key);
        return false;
    }
    await manager.client.rejectIdea(idea.id, {});
    history(ctx, { type: "aux", idea: idea.number, detail: "rejected idea" });
    markRecent(ctx, item.key);
    return true;
}
async function processEstimate(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const agent = pickWorker(ctx) ?? ctx.primary;
    const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
    const result = await withScratch(ctx, `estimate-${issue.number}`, (dir) => runEstimate({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    const value = Math.round(Number(result.value));
    if (!result.ok || !Number.isFinite(value) || value < 1 || value > 10) {
        ctx.logger.warn(`Estimate for #${issue.number} was not a whole 1-10 value; skipping`);
        markRecent(ctx, item.key);
        return false;
    }
    await agent.client.estimateReward(issue.id, {
        value,
        reason: result.reason ?? result.summary ?? "Estimated from the issue scope."
    });
    history(ctx, { type: "aux", issue: issue.number, detail: `estimated $${value}` });
    markRecent(ctx, item.key);
    return true;
}
async function processInvestigate(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const agent = pickWorker(ctx) ?? ctx.primary;
    const loopContext = await loopContextFor(ctx, { issue });
    const result = await withScratch(ctx, `investigate-${issue.number}`, (dir) => runInvestigate({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    const body = result.comment ?? result.description;
    if (!result.ok || !body) {
        markRecent(ctx, item.key);
        return false;
    }
    await agent.client.comment(issue.id, {
        summary: result.summary ?? `Investigation for #${issue.number}`,
        body,
        projectId: ctx.profile.ziki.projectId
    });
    history(ctx, { type: "aux", issue: issue.number, detail: "investigation comment" });
    markRecent(ctx, item.key);
    return true;
}
async function processImportance(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const agent = pickManager(ctx) ?? pickWorker(ctx);
    if (!agent) {
        markRecent(ctx, item.key);
        return false;
    }
    const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
    const result = await withScratch(ctx, `importance-${issue.number}`, (dir) => runImportance({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    if (!result.ok || result.important !== true) {
        markRecent(ctx, item.key);
        return false;
    }
    await agent.client.markImportant(issue.id);
    history(ctx, { type: "aux", issue: issue.number, detail: "marked important" });
    markRecent(ctx, item.key);
    return true;
}
async function processStakeVote(ctx, item) {
    const stakeIds = item.actions
        .map((action) => action.path.match(/stakes\/([^/]+)\/votes/)?.[1])
        .filter((value) => Boolean(value));
    if (stakeIds.length < 2) {
        const fallback = actionId(item, ["vote_stake"], /stakes\/([^/]+)\/votes/);
        if (fallback)
            stakeIds.push(fallback);
    }
    if (!stakeIds.length) {
        markRecent(ctx, item.key);
        return false;
    }
    const issue = item.issueId ? await loadIssueForItem(ctx, item) : null;
    const stakes = issue ? await ctx.primary.client.listStakes(issue.id).catch(() => null) : null;
    const voter = pickManager(ctx) ?? pickWorker(ctx);
    if (!voter) {
        markRecent(ctx, item.key);
        return false;
    }
    const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
    const result = await withScratch(ctx, `stake-${item.key.replace(/[^a-z0-9-]/gi, "-").slice(0, 40)}`, (dir) => runStakeVote({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        stakes: stakes?.stakes ?? [],
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    const chosen = result.voteForStakeId ?? result.stakeId ?? actionId(item, ["vote_stake"], /stakes\/([^/]+)\/votes/);
    if (!result.ok || !chosen) {
        markRecent(ctx, item.key);
        return false;
    }
    await voter.client.voteStake(chosen);
    history(ctx, { type: "aux", issue: issue?.number, detail: `voted stake ${chosen}`, data: { summary: result.summary } });
    markRecent(ctx, item.key);
    return true;
}
async function processSenseCheck(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const agent = pickManager(ctx) ?? pickWorker(ctx);
    if (!agent) {
        markRecent(ctx, item.key);
        return false;
    }
    const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
    const result = await withScratch(ctx, `sense-${issue.number}`, (dir) => runSenseCheck({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    if (!result.ok || result.abandon !== true) {
        markRecent(ctx, item.key);
        history(ctx, { type: "decision", issue: issue.number, detail: "sense check: left the claim alone" });
        return false;
    }
    await agent.client.abandonVote(issue.id, result.summary ?? "No activity and no evidence of work; voting abandoned.");
    history(ctx, { type: "aux", issue: issue.number, detail: "voted abandoned" });
    markRecent(ctx, item.key);
    return true;
}
const CLOSE_REASONS = new Set([
    "duplicate",
    "not_reproducible",
    "already_implemented",
    "invalid",
    "wont_fix",
    "superseded",
    "withdrawn"
]);
async function processClose(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const manager = pickManager(ctx);
    const actingAs = manager ? "manager" : "working";
    const agent = manager ?? pickWorker(ctx);
    if (!agent) {
        markRecent(ctx, item.key);
        return false;
    }
    const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
    const result = await withScratch(ctx, `close-${issue.number}`, (dir) => runClose({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        issue,
        actingAs,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, issue, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    const reason = String(result.closeReason ?? "").trim();
    if (!result.ok || !CLOSE_REASONS.has(reason)) {
        ctx.logger.info(`Close decision for #${issue.number} was not usable (${reason || "no reason"}); leaving it`);
        markRecent(ctx, item.key);
        return false;
    }
    const evidence = result.evidence ?? result.description ?? "";
    const summary = result.summary ?? `Close #${issue.number} as ${reason}`;
    if (actingAs === "manager" && manager) {
        await manager.client.closeIssue(issue.id, {
            reason,
            evidence,
            duplicateOf: result.duplicateOf ?? undefined
        });
        history(ctx, { type: "aux", issue: issue.number, detail: `closed as ${reason}` });
    }
    else {
        await agent.client.suggestClose(issue.id, {
            reason,
            evidence,
            summary,
            description: result.description,
            duplicateOf: result.duplicateOf ?? undefined
        });
        history(ctx, { type: "aux", issue: issue.number, detail: `suggested close as ${reason}` });
    }
    markRecent(ctx, item.key);
    return true;
}
async function processResearchJob(ctx, item) {
    const jobId = actionId(item, [], /\/jobs\/([^/]+)\/submissions/) ??
        item.actions.map((action) => action.path.match(/\/jobs\/([^/]+)/)?.[1]).find(Boolean) ??
        item.key.split(":").pop() ??
        null;
    if (!jobId) {
        markRecent(ctx, item.key);
        return false;
    }
    const agent = pickWorker(ctx) ?? ctx.primary;
    const job = await agent.client.getJob(jobId);
    const loopContext = await loopContextFor(ctx, { includeGit: false });
    const result = await withScratch(ctx, `research-${jobId}`, (dir) => runResearch({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        job,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, null, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    if (!result.ok || result.jobData === undefined) {
        markRecent(ctx, item.key);
        return false;
    }
    await agent.client.submitJob(jobId, result.jobData);
    history(ctx, { type: "aux", detail: `submitted research row for job ${jobId}` });
    markRecent(ctx, item.key);
    return true;
}
async function processReviewOffer(ctx, item) {
    const offerId = actionId(item, [], /\/reviews\/([^/]+)\/accept/);
    if (!offerId) {
        markRecent(ctx, item.key);
        return false;
    }
    const reviewer = agentForItem(ctx, item);
    await reviewer.client.acceptReviewOffer(offerId);
    history(ctx, { type: "accept", issue: item.issueNumber, detail: "accepted review offer" });
    await processTestFix(ctx, item, reviewer);
    return true;
}
async function processJobReviewOffer(ctx, item) {
    const offerId = actionId(item, [], /\/jobs\/reviews\/([^/]+)\/accept/);
    if (!offerId) {
        markRecent(ctx, item.key);
        return false;
    }
    const agent = agentForItem(ctx, item);
    await agent.client.acceptJobReview(offerId);
    const jobId = item.actions.map((action) => action.path.match(/\/jobs\/([^/]+)/)?.[1]).find(Boolean) ??
        `${item.detail ?? ""}`.match(/\bjob[ _-]?([A-Za-z0-9_-]+)/i)?.[1] ??
        null;
    if (!jobId) {
        ctx.logger.warn(`Accepted job review ${offerId} but could not find its job id; skipping the review`);
        markRecent(ctx, item.key);
        return true;
    }
    const job = await agent.client.getJob(jobId);
    const submission = (job.submissions ?? []).find((entry) => entry.status !== "accepted" && entry.status !== "rejected") ?? (job.submissions ?? [])[0];
    if (!submission?.id) {
        markRecent(ctx, item.key);
        return true;
    }
    const loopContext = await loopContextFor(ctx, { includeGit: false });
    const result = await withScratch(ctx, `job-review-${submission.id}`, (dir) => runJobReview({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        job,
        submission,
        memoryText: ctx.memoryText,
        repoDir: dir,
        loopContext,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, null, result.tokens);
    if (await handleProviderLimit(ctx, result)) {
        markRecent(ctx, item.key);
        return false;
    }
    const jobVerdict = result.verdict;
    if (!result.ok || (jobVerdict !== "accept" && jobVerdict !== "reject")) {
        markRecent(ctx, item.key);
        return false;
    }
    await agent.client.reviewJobSubmission(submission.id, {
        verdict: jobVerdict,
        notes: result.description ?? result.summary
    });
    history(ctx, { type: "aux", detail: `reviewed job submission ${submission.id}: ${result.verdict}` });
    markRecent(ctx, item.key);
    return true;
}
async function processReviewIdle(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue) {
        markRecent(ctx, item.key);
        return false;
    }
    const manager = pickManager(ctx);
    if (!manager) {
        markRecent(ctx, item.key);
        return false;
    }
    const idle = /idle|no update|nobody holds/i.test(`${item.title} ${item.detail}`);
    if (!idle) {
        ctx.logger.info(`review_idle for #${issue.number} does not look idle; leaving it`);
        markRecent(ctx, item.key);
        return false;
    }
    await manager.client.reclaim(issue.id);
    history(ctx, { type: "aux", issue: issue.number, detail: "reclaimed idle work" });
    markRecent(ctx, item.key);
    return true;
}
async function processDeliverStranded(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue?.pullRequestUrl) {
        markRecent(ctx, item.key);
        return false;
    }
    const manager = pickManager(ctx, [issue.holder?.agentName ?? ""]);
    if (!manager) {
        markRecent(ctx, item.key);
        return false;
    }
    const status = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
    let verdicts = 0;
    try {
        const tests = await manager.client.listTestResults(issue.id);
        verdicts = (tests.verdicts ?? []).filter((verdict) => verdict.goodToMerge && verdict.current !== false).length;
    }
    catch {
        verdicts = 0;
    }
    if (!status || status.merged || status.state === "CLOSED") {
        if (status)
            await reportPrStatusWith(ctx, manager, issue, status).catch(() => { });
        markRecent(ctx, item.key);
        return false;
    }
    await manager.client.deliver(issue.id, {
        pullRequestUrl: issue.pullRequestUrl,
        summary: `Delivering #${issue.number} on the holder's behalf: the pull request already has ${verdicts} good-to-merge verdict(s).`,
        description: [
            `The linked pull request is ${issue.pullRequestUrl}.`,
            `Latest report: state=${status.state}, checks=${status.checks}, mergeable=${String(status.mergeable)}.`,
            `Good-to-merge verdicts: ${verdicts}.`,
            item.detail ? `Ziki item: ${item.detail}` : ""
        ]
            .filter(Boolean)
            .join("\n"),
        testResults: `Ziki good-to-merge verdicts on this pull request: ${verdicts}`,
        headSha: status.headSha ?? issue.pullRequestHeadSha ?? undefined
    });
    history(ctx, { type: "delivery", issue: issue.number, detail: "delivered stranded work", data: { pr: issue.pullRequestUrl } });
    markRecent(ctx, item.key);
    return true;
}
async function processMergeFix(ctx, item) {
    const issue = await loadIssueForItem(ctx, item);
    if (!issue?.pullRequestUrl) {
        markRecent(ctx, item.key);
        return false;
    }
    const mode = resolveMergeMode(ctx.profile);
    const status = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
    if (!status) {
        markRecent(ctx, item.key);
        return false;
    }
    const reporter = pickManager(ctx, [issue.holder?.agentName ?? ""]) ?? pickWorker(ctx, [issue.holder?.agentName ?? ""]);
    if (mode === "never") {
        ctx.logger.info(`merge_fix for #${issue.number} skipped: mergeMode is "never"`);
        history(ctx, { type: "decision", issue: issue.number, detail: "merge skipped (mergeMode never)" });
        markRecent(ctx, item.key);
        return true;
    }
    if (mode === "handoff") {
        if (reporter)
            await reportPrStatusWith(ctx, reporter, issue, status);
        history(ctx, {
            type: "decision",
            issue: issue.number,
            detail: "merge handed off: reported PR status without merging (mergeMode handoff)"
        });
        markRecent(ctx, item.key);
        return true;
    }
    const zikiReady = issue.status === "merge" || issue.status === "accepted" || issue.substatus === "ready_to_merge" || issue.substatus === "accepted";
    const gate = mergeGateReason({
        zikiReady,
        checks: status.checks,
        mergeable: status.mergeable,
        merged: status.merged,
        state: status.state,
        reviewDecision: status.reviewDecision,
        approvedReviews: status.reviews.filter((review) => review.state === "APPROVED").length,
        requiredReviewers: ctx.profile.repo.requiredReviewers?.length ?? 0
    });
    if (gate) {
        ctx.logger.info(`merge_fix for #${issue.number} held: ${gate} (checks=${status.checks}, mergeable=${String(status.mergeable)}, review=${String(status.reviewDecision)})`);
        if (reporter)
            await reportPrStatusWith(ctx, reporter, issue, status).catch(() => { });
        history(ctx, { type: "decision", issue: issue.number, detail: "merge held by a gate" });
        markRecent(ctx, item.key);
        return true;
    }
    await ctx.github.mergePr(issue.pullRequestUrl, resolveMergeMethod(ctx.profile));
    const merged = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
    const manager = pickManager(ctx, [issue.holder?.agentName ?? ""]);
    if (merged && manager) {
        await reportPrStatusWith(ctx, manager, issue, merged).catch(() => { });
        const inDefault = await isInDefaultBranch(ctx, merged.mergeCommitSha);
        if (inDefault) {
            await manager.client.resolveIssue(issue.id, issue.pullRequestUrl).catch(() => { });
        }
    }
    history(ctx, { type: "delivery", issue: issue.number, detail: "merged and reported", data: { pr: issue.pullRequestUrl } });
    markRecent(ctx, item.key);
    return true;
}
async function discoveryPass(ctx) {
    if (!ctx.profile.discovery.enabled)
        return;
    if (!underCap(counter(ctx).discoveries, ctx.profile.limits.maxDiscoveriesPerDay))
        return;
    const every = ctx.profile.discovery.maxCyclesBeforeRun ?? ctx.profile.limits.maxCyclesBeforeDiscovery;
    if (ctx.state.cycles % every !== 0)
        return;
    const existing = (ctx.platform.issues ?? [])
        .filter((issue) => ["open", "in_progress", "done", "merge", "resolved", "closed"].includes(issue.status))
        .slice(0, 300)
        .map((issue) => `#${issue.number} ${issue.title} [${issue.status}/${issue.substatus}]`)
        .join("\n");
    const existingIdeas = (ctx.platform.ideas ?? [])
        .slice(0, 300)
        .map((idea) => `#${idea.number} ${idea.title} [${idea.status}]`)
        .join("\n");
    const recentMerged = (ctx.platform.issues ?? [])
        .filter((issue) => ["resolved", "closed"].includes(issue.status) || ["on_dev", "on_staging", "on_prod"].includes(issue.substatus))
        .slice(0, 60)
        .map((issue) => `#${issue.number} ${issue.title} [${issue.status}/${issue.substatus}]`)
        .join("\n");
    const inFlight = [
        ...Object.values(ctx.state.tasks)
            .filter((task) => ["claimed", "working", "delivered"].includes(task.status))
            .slice(0, 40)
            .map((task) => `#${task.number} ${task.title ?? ""} [${task.status}]`),
        ...Object.values(ctx.state.tasks)
            .filter((task) => task.claimId && ["claimed", "working"].includes(task.status))
            .slice(0, 40)
            .map((task) => `claim #${task.number} ${task.claimId}`)
    ].join("\n");
    const platformPolicy = [
        `platform: ${ctx.profile.ziki.platform}`,
        `project: ${ctx.profile.ziki.projectName ?? ctx.profile.ziki.projectSlug}`,
        `keywords: ${(ctx.profile.platformMatch.keywords ?? []).join(", ") || "(none)"}`,
        `regex: ${ctx.profile.platformMatch.regex ?? "(none)"}`,
        `max ideas per run: ${ctx.profile.discovery.maxIdeasPerRun ?? 3}`
    ].join("\n");
    const parityFile = resolveParityFile(ctx.profile);
    const parity = parityFile && existsSync(parityFile) ? await readFile(parityFile, "utf8") : "(no parity map yet)";
    const result = await withScratch(ctx, "discovery", (dir) => runDiscovery({
        profile: ctx.profile,
        profilePaths: ctx.profilePaths,
        memoryText: ctx.memoryText,
        repoDir: dir,
        parity,
        existingIssues: [existing, recentMerged ? `\n## Recently merged or delivered\n${recentMerged}` : "", inFlight ? `\n## In flight\n${inFlight}` : "", `\n## Platform policy\n${platformPolicy}`].filter(Boolean).join("\n"),
        existingIdeas,
        maxIdeas: ctx.profile.discovery.maxIdeasPerRun ?? 3,
        logger: ctx.logger,
        ...agentHooks(ctx)
    }));
    taskUsage(ctx, null, result.tokens);
    if (await handleProviderLimit(ctx, result))
        return;
    if (!result.ok) {
        ctx.logger.warn(`Discovery failed: ${result.error ?? result.blocker ?? "unknown"}`);
        return;
    }
    const ideas = (result.ideas ?? []).slice(0, ctx.profile.discovery.maxIdeasPerRun ?? 3);
    for (const idea of ideas) {
        if (!idea?.title || !idea?.description)
            continue;
        let summary = idea.summary || idea.title;
        if (summary.length < 20)
            summary = `${summary} — platform parity gap.`;
        const baseInput = {
            title: idea.title.slice(0, 200),
            summary: summary.slice(0, 300),
            description: idea.description.slice(0, 5000),
            platform: ctx.profile.ziki.platform,
            idempotencyKey: `aw-${ctx.profileName}-${new Date().toISOString().slice(0, 10)}-${slugify(idea.title, 50)}`,
            acknowledgeSimilar: false
        };
        const vetted = ctx.profile.discovery.alreadyVetted === true && Boolean(ctx.profile.discovery.vettedNote);
        try {
            const created = await ctx.primary.client.createIdea(vetted ? { ...baseInput, alreadyVetted: true, vettedNote: ctx.profile.discovery.vettedNote } : baseInput);
            const createdIdea = normalizeIdea(created);
            counter(ctx).discoveries += 1;
            ctx.state.run.discoveries += 1;
            const converted = created?.converted;
            ctx.logger.info(converted?.issueNumber
                ? `Filed and converted idea to issue #${converted.issueNumber}: ${idea.title}`
                : `Filed idea #${createdIdea?.number ?? "?"}: ${idea.title}`);
        }
        catch (error) {
            const status = error.status;
            const code = String(error.body?.error ?? "");
            if (status === 409) {
                ctx.logger.info(`Idea skipped as similar: ${idea.title}`);
            }
            else if (vetted && (status === 429 || code === "vetted_limit" || status === 400 || code === "invalid_request")) {
                ctx.logger.warn(`Vetted idea refused (${code || status}); filing it normally: ${idea.title}`);
                try {
                    const retried = await ctx.primary.client.createIdea(baseInput);
                    const createdIdea = normalizeIdea(retried);
                    counter(ctx).discoveries += 1;
                    ctx.state.run.discoveries += 1;
                    ctx.logger.info(`Filed idea #${createdIdea?.number ?? "?"}: ${idea.title}`);
                }
                catch (retryError) {
                    const retryStatus = retryError.status;
                    if (retryStatus === 409)
                        ctx.logger.info(`Idea skipped as similar: ${idea.title}`);
                    else
                        ctx.logger.warn(`Could not file idea "${idea.title}": ${retryError instanceof Error ? retryError.message : String(retryError)}`);
                }
            }
            else {
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
async function cleanupOldWorktrees(ctx) {
    const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
    for (const task of Object.values(ctx.state.tasks)) {
        if (!task.worktree)
            continue;
        if (!["done", "failed", "skipped"].includes(task.status))
            continue;
        if (new Date(task.updatedAt).getTime() > cutoff)
            continue;
        await cleanupWorktree(ctx.github, task.worktree);
        task.worktree = undefined;
        ctx.logger.info(`Cleaned worktree for #${task.number}`);
    }
}
async function ownerDecisionPass(ctx) {
    const candidates = (ctx.platform.issues ?? []).filter((issue) => issue.substatus === "requires_confirmation" ||
        issue.substatus === "requires_review" ||
        issue.status === "requires_confirmation" ||
        ["done", "accepted", "merge"].includes(issue.status));
    for (const candidate of candidates.slice(0, 25)) {
        if (ctx.pool.total() >= ctx.capacity.agentCeiling)
            return;
        const data = await ctx.primary.client.getIssue(candidate.id).catch(() => null);
        const issue = normalizeIssue(data);
        if (!issue)
            continue;
        const decisions = parseOwnerDecisions(issue.comments);
        if (!decisions.length)
            continue;
        const stateKey = (decision) => `decision:${issue.id}:${decision.kind}:${decision.answer}:${decision.text.slice(0, 80)}`;
        const confirm = latestDecision(decisions, "confirm");
        const merge = latestDecision(decisions, "merge");
        if (confirm && (issue.substatus === "requires_confirmation" || issue.status === "requires_confirmation")) {
            const key = stateKey(confirm);
            if (ctx.state.recentFeedKeys[key])
                continue;
            const confirmer = pickManagerOrWorker(ctx);
            if (!confirmer)
                continue;
            try {
                if (!confirm.answer) {
                    await confirmer.client.confirmIssue(issue.id, {
                        verdict: "reject",
                        summary: `Owner decision: do not confirm #${issue.number}.`,
                        description: confirm.text
                    });
                    history(ctx, { type: "decision", issue: issue.number, detail: "owner said no: rejected confirmation" });
                }
                else {
                    const loopContext = await loopContextFor(ctx, { issue, includeGit: false });
                    const result = await withScratch(ctx, `decision-confirm-${issue.number}`, (dir) => runConfirm({
                        profile: ctx.profile,
                        profilePaths: ctx.profilePaths,
                        issue,
                        memoryText: ctx.memoryText,
                        repoDir: dir,
                        loopContext,
                        logger: ctx.logger,
                        ...agentHooks(ctx)
                    }));
                    taskUsage(ctx, issue, result.tokens);
                    if (await handleProviderLimit(ctx, result))
                        return;
                    if (!result.ok) {
                        ctx.logger.warn(`Owner said confirm #${issue.number}, but the confirmation agent failed: ${result.error ?? result.blocker ?? "unknown"}`);
                        continue;
                    }
                    const response = await confirmer.client.confirmIssue(issue.id, {
                        verdict: "confirm",
                        summary: result.summary ?? `Owner decision: confirm #${issue.number}.`,
                        description: [confirm.text, result.description ?? ""].filter(Boolean).join("\n\n"),
                        files: fileEvidence(result.files),
                        duplicateOfId: result.duplicateOfId ?? undefined
                    });
                    if (response?.confirmed)
                        await confirmer.client.openIssue(issue.id).catch(() => { });
                    history(ctx, { type: "decision", issue: issue.number, detail: "owner said yes: confirmed issue" });
                }
                markRecent(ctx, key);
            }
            catch (error) {
                ctx.logger.warn(`Owner confirmation decision for #${issue.number} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (merge && (["done", "accepted", "merge"].includes(issue.status) || issue.substatus === "requires_review")) {
            const key = stateKey(merge);
            if (ctx.state.recentFeedKeys[key])
                continue;
            const manager = pickManager(ctx, [issue.holder?.agentName ?? ""]) ?? pickManager(ctx);
            if (!manager)
                continue;
            try {
                if (!merge.answer) {
                    await manager.client.mergeReview(issue.id, {
                        verdict: "reject",
                        summary: `Owner decision: do not merge #${issue.number}.`,
                        description: merge.text
                    });
                    history(ctx, { type: "decision", issue: issue.number, detail: "owner said no: rejected merge" });
                    markRecent(ctx, key);
                    continue;
                }
                const mode = resolveMergeMode(ctx.profile);
                if (mode === "never") {
                    history(ctx, { type: "decision", issue: issue.number, detail: "owner said merge, but mergeMode is never" });
                    markRecent(ctx, key);
                    continue;
                }
                if (mode === "handoff") {
                    if (issue.pullRequestUrl) {
                        const status = await ctx.github.prStatus(issue.pullRequestUrl).catch(() => null);
                        if (status)
                            await reportPrStatusWith(ctx, manager, issue, status);
                    }
                    history(ctx, { type: "decision", issue: issue.number, detail: "owner said merge: handed off, PR reported" });
                    markRecent(ctx, key);
                    continue;
                }
                const synthetic = {
                    key: `decision-merge:${issue.id}`,
                    kind: "merge_fix",
                    priority: 0,
                    item: {
                        kind: "merge_fix",
                        key: `decision-merge:${issue.id}`,
                        title: `Merge #${issue.number}`,
                        detail: merge.text,
                        minimumRole: "merger",
                        canAct: true,
                        actions: []
                    },
                    issueId: issue.id,
                    issueNumber: issue.number,
                    ideaId: null,
                    ideaNumber: null,
                    title: `Merge #${issue.number}`,
                    detail: merge.text,
                    actions: [],
                    bucket: "review"
                };
                await processMergeFix(ctx, synthetic);
                markRecent(ctx, key);
            }
            catch (error) {
                ctx.logger.warn(`Owner merge decision for #${issue.number} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
async function syncAgentProfile(ctx) {
    const config = ctx.profile.agentProfile;
    if (!config)
        return;
    const client = ctx.primary.client;
    try {
        const patch = {};
        if (config.username)
            patch.username = config.username;
        if (config.tagline !== undefined)
            patch.tagline = config.tagline;
        if (config.about !== undefined)
            patch.about = config.about;
        if (Object.keys(patch).length)
            await client.updateProfile(patch);
        if (Array.isArray(config.skills))
            await client.setSkills(config.skills);
        if (config.pictureFile && existsSync(config.pictureFile))
            await client.setPicture(config.pictureFile);
        ctx.profileSynced = true;
        ctx.logger.info("Agent profile synced from config", { fields: Object.keys(patch) });
    }
    catch (error) {
        ctx.logger.warn(`Agent profile sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function runCycle(ctx) {
    const started = Date.now();
    ctx.state.cycles += 1;
    ctx.cycleStats = { deliveries: 0, reviews: 0, aux: 0, errors: 0 };
    ctx.state.lastCycleAt = new Date().toISOString();
    ctx.state.lastCycleMs = null;
    if (await isStopped(ctx.profilePaths))
        return { stopped: true };
    if (await isPaused(ctx.profilePaths)) {
        ctx.logger.info("Paused; waiting for resume");
        return { paused: true };
    }
    setPhase(ctx, "poll");
    await poll(ctx.primary.client, ctx.profile, ctx.profilePaths, ctx.state, {
        logger: ctx.logger,
        markInboxRead: !ctx.dryRun,
        clientForName: (name) => clientByName(ctx, name)?.client ?? null
    });
    setPhase(ctx, "feed");
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
        setPhase(ctx, "dry-run");
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
    setPhase(ctx, "decisions");
    await ownerDecisionPass(ctx);
    setPhase(ctx, "heartbeat");
    await heartbeatPass(ctx);
    setPhase(ctx, "dispatch");
    dispatch(ctx);
    await cleanupOldWorktrees(ctx);
    pruneState(ctx.state);
    ctx.state.lastCycleMs = Date.now() - started;
    setPhase(ctx, "idle");
    await save(ctx);
    await notifyNeedsYou(ctx);
    ctx.logger.info("Cycle complete", {
        cycles: ctx.state.cycles,
        ms: ctx.state.lastCycleMs,
        queue: ctx.queue.counts,
        inFlight: ctx.pool.total(),
        deliveries: counter(ctx).deliveries,
        reviews: counter(ctx).reviews,
        needsYou: Object.values(ctx.state.escalations).filter((escalation) => escalation.status === "open").length
    });
    return { ok: true };
}
function discoveryDue(ctx) {
    if (!ctx.profile.discovery.enabled)
        return false;
    if (!underCap(counter(ctx).discoveries, ctx.profile.limits.maxDiscoveriesPerDay))
        return false;
    const every = ctx.profile.discovery.maxCyclesBeforeRun ?? ctx.profile.limits.maxCyclesBeforeDiscovery;
    return ctx.state.cycles > 0 && ctx.state.cycles % every === 0;
}
function nextItem(ctx, bucket) {
    return (bucket ?? []).find((entry) => !ctx.pool.has(entry.key) && entry.item.canAct !== false) ?? null;
}
async function processWorkSafe(ctx, item, worker) {
    try {
        await processWorkItem(ctx, item, worker);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const network = isTransientNetworkError(error);
        ctx.logger.error(`Delivery for #${item.issueNumber} crashed: ${message}`);
        ctx.live?.note(`#${item.issueNumber} crashed: ${truncate(message, 120)}`);
        counter(ctx).errors += 1;
        ctx.cycleStats.errors += 1;
        if (network) {
            ctx.state.run.networkErrors += 1;
            ctx.consecutiveNetworkErrors += 1;
        }
        else {
            ctx.state.run.failures += 1;
        }
        const requeued = await requeueCrashedTask(ctx, item, error);
        history(ctx, {
            type: "failure",
            issue: item.issueNumber,
            detail: `${network ? "network error: " : ""}${message}${requeued ? " (requeued)" : ""}`
        });
        if (!requeued)
            markRecent(ctx, item.key);
        await save(ctx).catch(() => { });
    }
}
async function processReviewSafe(ctx, item) {
    try {
        if (item.kind === "test_fix")
            await processTestFix(ctx, item);
        else if (item.kind === "accept_fix")
            await processAccept(ctx, item);
        else if (item.kind === "review_idle")
            await processReviewIdle(ctx, item);
        else if (item.kind === "deliver_stranded")
            await processDeliverStranded(ctx, item);
        else if (item.kind === "merge_fix")
            await processMergeFix(ctx, item);
        else if (item.kind === "reconcile_merged")
            await processReconcileMerged(ctx, item);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const network = isTransientNetworkError(error);
        ctx.logger.error(`Review for #${item.issueNumber} crashed: ${message}`);
        ctx.live?.note(`#${item.issueNumber} review crashed: ${truncate(message, 120)}`);
        counter(ctx).errors += 1;
        ctx.cycleStats.errors += 1;
        if (network) {
            ctx.state.run.networkErrors += 1;
            ctx.consecutiveNetworkErrors += 1;
        }
        else {
            ctx.state.run.failures += 1;
        }
        const requeued = await requeueCrashedTask(ctx, item, error);
        history(ctx, {
            type: "failure",
            issue: item.issueNumber,
            detail: `${network ? "network error: " : ""}${message}${requeued ? " (requeued)" : ""}`
        });
        if (!requeued)
            markRecent(ctx, item.key);
        await save(ctx).catch(() => { });
    }
}
function reportUnsupported(ctx) {
    for (const entry of ctx.queue?.other ?? []) {
        if (ctx.unsupportedKinds.has(entry.kind))
            continue;
        ctx.unsupportedKinds.add(entry.kind);
        ctx.logger.warn(`Unsupported Ziki work kind "${entry.kind}" (key ${entry.key}); it is visible in status but not handled`);
        history(ctx, {
            type: "unsupported",
            issue: entry.issueNumber,
            idea: entry.ideaNumber,
            detail: `unsupported work kind: ${entry.kind}`
        });
    }
}
function dispatch(ctx) {
    if (ctx.providerLimit || ctx.tokenLimitReached || Date.now() < ctx.rateLimitUntil)
        return;
    const limits = ctx.profile.limits;
    const pool = ctx.pool;
    const capacity = ctx.capacity;
    ctx.auxThisCycle = 0;
    reportUnsupported(ctx);
    if (pool.canStart("owner")) {
        const owner = nextItem(ctx, ctx.queue?.owner);
        if (owner)
            pool.reserve(owner.key, "owner", () => processOwnerItem(ctx, owner), `owner ${truncate(owner.title, 40)}`);
    }
    while (pool.canStart("followup")) {
        const task = Object.values(ctx.state.tasks).find((entry) => prFollowUpDue(ctx, entry));
        if (!task)
            break;
        pool.reserve(prTaskKey(task), "followup", () => processPrFollowUpSafe(ctx, task), followUpLabel(task));
    }
    while (pool.canStart("delivery") && pool.count("delivery") < capacity.delivery) {
        if (activeClaims(ctx).length + pool.count("delivery") >= capacity.activeClaims)
            break;
        if (!underCap(counter(ctx).deliveries, limits.maxDeliveriesPerDay))
            break;
        if (limits.maxDeliveriesTotal != null && ctx.state.run.deliveries >= limits.maxDeliveriesTotal)
            break;
        const item = (ctx.queue?.work ?? []).find((entry) => {
            if (!entry.issueId || pool.has(entry.key))
                return false;
            const task = ctx.state.tasks[entry.issueId];
            return !task || !["waiting_human", "delivered", "done", "failed", "skipped"].includes(task.status);
        });
        if (!item)
            break;
        const worker = pickAvailableWorker(ctx);
        if (!worker)
            break;
        ctx.reservedAgents.add(worker.name);
        pool.reserve(item.key, "delivery", async () => {
            try {
                await processWorkSafe(ctx, item, worker);
            }
            finally {
                ctx.reservedAgents.delete(worker.name);
            }
        }, taskLabel(item));
    }
    while (pool.canStart("review") && pool.count("review") < capacity.review) {
        if (!underCap(counter(ctx).reviews, limits.maxReviewsPerDay))
            break;
        const item = nextItem(ctx, ctx.queue?.review);
        if (!item)
            break;
        pool.reserve(item.key, "review", () => processReviewSafe(ctx, item), kindLabel(item, "review"));
    }
    while (pool.canStart("aux") && pool.count("aux") < capacity.aux && underCap(ctx.auxThisCycle, limits.maxAuxPerCycle)) {
        const item = nextItem(ctx, ctx.queue?.aux);
        if (!item)
            break;
        ctx.auxThisCycle += 1;
        pool.reserve(item.key, "aux", async () => {
            await processAuxItem(ctx, item);
            await save(ctx).catch(() => { });
        }, kindLabel(item, "aux"));
    }
    if (pool.canStart("discovery") && discoveryDue(ctx) && !pool.has("discovery")) {
        pool.reserve("discovery", "discovery", () => discoveryPass(ctx), "discovery");
    }
}
function underCap(value, cap) {
    if (cap === null || cap === "auto" || cap === undefined)
        return true;
    return value < Number(cap);
}
async function createContext(loaded, state, logger, options) {
    const { profile, profileName, keys } = loaded;
    const toClients = (agents) => agents.map((agent) => ({ ...agent, client: clientForAgent(agent, profile) }));
    const clients = {
        workers: toClients(keys.workers),
        managers: toClients(keys.managers)
    };
    const primary = clients.workers[0] ?? clients.managers[0];
    if (!primary)
        throw new Error("No valid agent keys. Add them to the env file.");
    const capacity = resolveCapacity(profile, keys);
    const github = new GitHub({ profile, profileName, reposDir: loaded.profilePaths.reposDir, logger });
    let repoReady = false;
    try {
        await github.ensureRepo();
        repoReady = true;
    }
    catch (error) {
        throw new Error(`Repository is not ready: ${error instanceof Error ? error.message : String(error)}`);
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
            delivery: capacity.delivery,
            followup: capacity.followup,
            review: capacity.review,
            aux: capacity.aux,
            discovery: capacity.discovery,
            owner: capacity.owner,
            agents: capacity.agentCeiling
        }),
        mutex: new Mutex(),
        runLimits: options.runLimits,
        auxThisCycle: 0,
        reservedAgents: new Set(),
        cycleStats: { deliveries: 0, reviews: 0, aux: 0, errors: 0 },
        lastNeedsYouCount: null,
        tokenWarned: false,
        tokenLimitReached: false,
        providerLimit: null,
        providerLimitNotified: false,
        rateLimitUntil: 0,
        rateLimitCount: 0,
        phase: "starting",
        activity: null,
        phaseStartedAt: new Date().toISOString(),
        live: null,
        consecutiveNetworkErrors: 0,
        capacity,
        unsupportedKinds: new Set(),
        profileSynced: false
    };
}
async function readRunLimitsFile(profilePaths) {
    if (!existsSync(profilePaths.runLimitsFile))
        return null;
    try {
        return JSON.parse(await readFile(profilePaths.runLimitsFile, "utf8"));
    }
    catch {
        return null;
    }
}
function killStalePids(state, logger) {
    const alive = [];
    for (const pid of state.activePids ?? []) {
        if (!isAlive(pid))
            continue;
        alive.push(pid);
        logger.warn(`Killing stale agent process from a previous run (pid ${pid})`);
        killProcessTree(pid);
    }
    state.activePids = [];
    return alive;
}
async function reconcileWorktreesOnStartup(ctx, blockedPids = []) {
    if ([...(ctx.state.activePids ?? []), ...blockedPids].some((pid) => isAlive(pid))) {
        ctx.logger.warn("Skipping worktree cleanup: recorded agent processes are still alive");
        return;
    }
    for (const task of Object.values(ctx.state.tasks)) {
        if (!task.worktree)
            continue;
        if (!["done", "failed", "skipped"].includes(task.status))
            continue;
        await cleanupWorktree(ctx.github, task.worktree);
        task.worktree = undefined;
    }
    const live = new Set(Object.values(ctx.state.tasks)
        .map((task) => task.worktree)
        .filter((value) => Boolean(value)));
    const entries = await readdir(ctx.profilePaths.worktreesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const full = path.join(ctx.profilePaths.worktreesDir, entry.name);
        if (live.has(full))
            continue;
        const info = await stat(full).catch(() => null);
        if (!info || Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000)
            continue;
        await cleanupWorktree(ctx.github, full);
        ctx.logger.info(`Removed stale worktree ${entry.name}`);
    }
}
function limitReached(ctx) {
    const limits = ctx.runLimits;
    if (limits.maxCycles !== null && ctx.state.cycles >= limits.maxCycles)
        return "max-cycles";
    if (limits.maxDeliveriesTotal !== null && ctx.state.run.deliveries >= limits.maxDeliveriesTotal)
        return "max-deliveries";
    if (limits.stopAt) {
        const at = new Date(limits.stopAt).getTime();
        if (Number.isFinite(at) && Date.now() >= at)
            return "until";
    }
    if (limits.maxRuntimeMinutes !== null) {
        const started = ctx.state.run.startedAt ? new Date(ctx.state.run.startedAt).getTime() : Date.now();
        if (Date.now() - started >= limits.maxRuntimeMinutes * 60 * 1000)
            return "max-runtime";
    }
    return null;
}
export async function runLoop(options = {}) {
    const loaded = await loadProfile(options.profileName);
    const logger = createLogger({
        name: `auto-work.${loaded.profileName}`,
        logDir: loaded.profilePaths.logsDir,
        foreground: options.verbose === true
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
        if (task.status === "working")
            task.status = "queued";
    }
    if (state.run.startedAt && !state.lastRun?.clean) {
        const previous = buildRunSummary({
            state,
            profileName: loaded.profileName,
            profile: loaded.profile,
            clean: false,
            stopReason: "killed",
            endedAt: state.lastRun?.lastActivityAt ?? state.lastCycleAt ?? state.run.startedAt
        });
        state.lastRun = previous;
        await writeRunSummary(loaded.profilePaths, previous).catch(() => { });
        logger.warn("Previous run did not shut down cleanly", { startedAt: previous.startedAt, deliveries: previous.deliveries });
        console.log(formatRunSummary(previous, { files: true }));
    }
    const storedLimits = await readRunLimitsFile(loaded.profilePaths);
    const runLimits = resolveRunLimits(loaded.profile, options.limits ?? storedLimits ?? null);
    state.run = {
        startedAt: new Date().toISOString(),
        limits: runLimits,
        stopReason: null,
        deliveries: 0,
        reviews: 0,
        mergeReviews: 0,
        discoveries: 0,
        aux: 0,
        failures: 0,
        networkErrors: 0,
        tokens: emptyUsage()
    };
    state.lastRun = buildRunSummary({
        state,
        profileName: loaded.profileName,
        profile: loaded.profile,
        clean: false,
        stopReason: null
    });
    state.lastCycle = null;
    await saveState(loaded.profilePaths, state);
    await writePid(loaded.profilePaths, process.pid);
    let ctx;
    try {
        ctx = await createContext(loaded, state, logger, { dryRun: Boolean(options.dryRun), runLimits });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Startup failed: ${message}`);
        console.error(`Startup failed: ${message}`);
        await releaseLock(loaded.profilePaths);
        await clearPid(loaded.profilePaths);
        return 1;
    }
    await reconcileWorktreesOnStartup(ctx, stalePids).catch(() => { });
    const live = new LiveStatus({
        enabled: options.foreground !== false && !options.verbose,
        render: () => renderLive(ctx)
    });
    ctx.live = live;
    setPhase(ctx, "idle");
    live.start();
    const controller = new AbortController();
    const shutdown = (signal) => {
        logger.info(`Stopping on ${signal}`);
        controller.abort();
        killActiveAgents();
    };
    const onSigint = () => shutdown("SIGINT");
    const onSigterm = () => shutdown("SIGTERM");
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
    await syncAgentProfile(ctx);
    await writeStatus(ctx, { running: true });
    let stopReason = null;
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
                ctx.consecutiveNetworkErrors = 0;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const network = isTransientNetworkError(error);
                ctx.state.lastError = {
                    at: new Date().toISOString(),
                    error: message,
                    stack: truncate(error instanceof Error ? error.stack : "", 1500)
                };
                logger.error(`Cycle failed: ${message}`);
                ctx.live?.note(`cycle failed: ${truncate(message, 120)}`);
                if (network) {
                    ctx.state.run.networkErrors += 1;
                    ctx.consecutiveNetworkErrors += 1;
                }
                await save(ctx).catch(() => { });
                if (options.once) {
                    stopReason = "error";
                    break;
                }
                const maxNetworkRetries = ctx.profile.limits.maxNetworkRetries ?? 5;
                const networkRetryMs = (ctx.profile.limits.networkRetryMinutes ?? 1) * 60_000;
                if (network && !controller.signal.aborted && ctx.consecutiveNetworkErrors < maxNetworkRetries) {
                    await sleep(networkRetryMs, controller.signal);
                    continue;
                }
                if (network) {
                    stopReason = "network";
                    break;
                }
            }
            if (ctx.tokenLimitReached) {
                stopReason = "token-limit";
                logger.info("Run token budget reached", { tokens: ctx.state.run.tokens.total });
                await ctx.pool.drain(120_000);
                break;
            }
            if (ctx.providerLimit) {
                stopReason = "provider-limit";
                logger.info("Provider limit reached; stopping");
                await ctx.pool.drain(120_000);
                break;
            }
            if (options.once) {
                await ctx.pool.drain(120_000);
                break;
            }
            if (ctx.rateLimitUntil > Date.now()) {
                await sleep(ctx.rateLimitUntil - Date.now(), controller.signal);
                continue;
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
    }
    catch (error) {
        stopReason = "error";
        ctx.state.lastError = {
            at: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
            stack: truncate(error instanceof Error ? error.stack : "", 1500)
        };
        logger.error(`Loop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        if (!stopReason && controller.signal.aborted)
            stopReason = "stop";
        ctx.state.run.stopReason = stopReason;
        ctx.state.stoppedAt = new Date().toISOString();
        const finalSummary = buildRunSummary({
            state: ctx.state,
            profileName: ctx.profileName,
            profile: ctx.profile,
            clean: true,
            stopReason: stopReason ?? "stop",
            endedAt: ctx.state.stoppedAt
        });
        ctx.state.lastRun = finalSummary;
        const hardStop = stopReason === "stop" ||
            stopReason === "error" ||
            stopReason === "network" ||
            controller.signal.aborted;
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
        await save(ctx).catch(() => { });
        await writeStatus(ctx, { running: false }).catch(() => { });
        await writeRunSummary(ctx.profilePaths, finalSummary).catch(() => { });
        live.stop();
        ctx.live = null;
        console.log(formatRunSummary(finalSummary, { files: true }));
        await releaseLock(loaded.profilePaths);
        await clearPid(loaded.profilePaths);
        logger.info("Auto-work loop stopped", { stopReason });
    }
    return 0;
}
export async function runOnceDry(profileName) {
    return runLoop({ profileName, foreground: true, once: true, dryRun: true });
}
//# sourceMappingURL=orchestrator.js.map