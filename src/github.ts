import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Issue, ProfileConfig } from "./types.js";
import { resolvePrTemplate } from "./config.js";
import { runCommand } from "./platform/spawn.js";
import { envFilesFor } from "./env.js";
import { isTransientNetworkText } from "./network.js";

import type { GithubPolicyConfig } from "./types.js";

export interface GithubCheckStates {
  passing: string;
  failing: string;
  pending: string;
  none: string;
}

export interface ResolvedGithubPolicy {
  stateMap: { merged: string[]; closed: string[] };
  mergeableMap: { mergeable: string; conflicting: string };
  mergeFlags: Record<string, string>;
  defaultMergeMethod: string;
  timeouts: { fetch: number; view: number; create: number; merge: number };
}

function requireStringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${path} must be an array of strings (run \`auto-work migrate\`)`);
  }
  return value as string[];
}

function requireTimeouts(value: unknown): ResolvedGithubPolicy["timeouts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile.github.timeouts is required (run `auto-work migrate`)");
  }
  const out: Record<string, number> = {};
  for (const key of ["fetch", "view", "create", "merge"]) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
      throw new Error(`profile.github.timeouts.${key} must be a positive number (run \`auto-work migrate\`)`);
    }
    out[key] = entry;
  }
  return out as ResolvedGithubPolicy["timeouts"];
}

function requireGithubPolicy(profile: ProfileConfig): ResolvedGithubPolicy {
  const github = profile.github;
  if (!github || typeof github !== "object") {
    throw new Error("profile.github is required (run `auto-work migrate`)");
  }
  const stateMap = github.stateMap;
  const mergeableMap = github.mergeableMap;
  if (!stateMap || typeof stateMap !== "object") {
    throw new Error("profile.github.stateMap is required (run `auto-work migrate`)");
  }
  if (!mergeableMap || typeof mergeableMap !== "object") {
    throw new Error("profile.github.mergeableMap is required (run `auto-work migrate`)");
  }
  const mergeFlags = github.mergeFlags;
  if (!mergeFlags || typeof mergeFlags !== "object" || Array.isArray(mergeFlags)) {
    throw new Error("profile.github.mergeFlags must be an object of method -> flag (run `auto-work migrate`)");
  }
  for (const [key, value] of Object.entries(mergeFlags)) {
    if (typeof value !== "string" || !value) {
      throw new Error(`profile.github.mergeFlags.${key} must be a non-empty string (run \`auto-work migrate\`)`);
    }
  }
  if (typeof github.defaultMergeMethod !== "string" || !github.defaultMergeMethod) {
    throw new Error("profile.github.defaultMergeMethod must be a non-empty string (run `auto-work migrate`)");
  }
  return {
    stateMap: {
      merged: requireStringList(stateMap.merged, "profile.github.stateMap.merged"),
      closed: requireStringList(stateMap.closed, "profile.github.stateMap.closed")
    },
    mergeableMap: {
      mergeable: requireGithubString(mergeableMap.mergeable, "profile.github.mergeableMap.mergeable"),
      conflicting: requireGithubString(mergeableMap.conflicting, "profile.github.mergeableMap.conflicting")
    },
    mergeFlags: mergeFlags as Record<string, string>,
    defaultMergeMethod: github.defaultMergeMethod,
    timeouts: requireTimeouts(github.timeouts)
  };
}

function requireGithubString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${path} must be a non-empty string (run \`auto-work migrate\`)`);
  }
  return value;
}

export function slugify(text: string, max = 40): string {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function branchName(issue: { number: number | string }, title: string, prefix: string): string {
  if (typeof prefix !== "string" || !prefix) {
    throw new Error("branch prefix is required (workflow.branchPrefix, run `auto-work migrate`)");
  }
  const clean = prefix.replace(/\/+$/, "");
  return `${clean}/${issue.number}-${slugify(title)}`;
}

export function summarizeChecks(
  rollup: Array<Record<string, unknown>>,
  states: GithubCheckStates
): string {
  for (const key of ["passing", "failing", "pending", "none"] as const) {
    if (typeof states?.[key] !== "string" || !states[key]) {
      throw new Error(`check states.${key} must be a non-empty string (run \`auto-work migrate\`)`);
    }
  }
  const { passing, failing, pending, none } = states;
  if (!rollup.length) return none;
  let pendingCount = 0;
  let failingCount = 0;
  for (const check of rollup) {
    const status = String(check.status ?? check.state ?? "");
    const conclusion = String(check.conclusion ?? "");
    if (["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(status)) pendingCount += 1;
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
      failingCount += 1;
    }
  }
  if (failingCount) return failing;
  if (pendingCount) return pending;
  return passing;
}

export interface PrComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number | null;
  url?: string;
  createdAt?: string;
  kind: "conversation" | "review";
}

export interface PrCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
}

export interface PrReview {
  author: string;
  state: string;
  body: string;
  submittedAt?: string;
}

export interface GitHubPrStatus {
  number?: number;
  url: string;
  state: string;
  merged: boolean;
  mergedInto: string | null;
  mergeCommitSha: string | null;
  headSha: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  checks: string;
  mergeable: boolean | null;
  reviewDecision: string | null;
  comments: PrComment[];
  reviews: PrReview[];
  checkRuns: PrCheck[];
  isDraft?: boolean;
}

export class GitHub {
  profile: ProfileConfig;
  profileName: string;
  repoDir: string;
  logger: { info: (m: string, f?: Record<string, unknown>) => Promise<void>; warn: (m: string, f?: Record<string, unknown>) => Promise<void> } | null;

  constructor(options: {
    profile: ProfileConfig;
    profileName: string;
    reposDir: string;
    logger?: GitHub["logger"];
  }) {
    this.profile = options.profile;
    this.profileName = options.profileName;
    this.repoDir = path.join(options.reposDir, "repo");
    this.logger = options.logger ?? null;
  }

  private async retryCommand<T extends { ok: boolean; stdout: string; stderr: string }>(
    operation: () => Promise<T>
  ): Promise<T> {
    let last: T | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await operation();
      if (last.ok || !isTransientNetworkText(`${last.stderr}\n${last.stdout}`)) return last;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    return last as T;
  }

  async git(args: string[], options: { cwd?: string; timeoutMs?: number; retry?: boolean } = {}) {
    const run = () =>
      runCommand(this.profile.toolchain.git || "git", args, {
        cwd: options.cwd ?? this.repoDir,
        timeoutMs: options.timeoutMs ?? 120_000
      });
    return options.retry ? this.retryCommand(run) : run();
  }

  async gh(args: string[], options: { cwd?: string; timeoutMs?: number; retry?: boolean } = {}) {
    const run = () =>
      runCommand(this.profile.toolchain.gh || "gh", args, {
        cwd: options.cwd ?? this.repoDir,
        timeoutMs: options.timeoutMs ?? 120_000
      });
    return options.retry ? this.retryCommand(run) : run();
  }

  async ensureRepo(): Promise<string> {
    const { url, upstream, base } = this.profile.repo;
    await mkdir(this.repoDir, { recursive: true });
    if (!existsSync(path.join(this.repoDir, ".git"))) {
      this.logger?.info(`Cloning ${url} -> ${this.repoDir}`);
      const clone = await runCommand(this.profile.toolchain.git || "git", ["clone", url, this.repoDir], {
        timeoutMs: 600_000
      });
      if (!clone.ok) throw new Error(clone.stderr || clone.stdout || "git clone failed");
    }

    const remotes = (await this.git(["remote"]).catch(() => ({ stdout: "" }))).stdout.split(/\s+/);
    if (!remotes.includes("origin")) await this.git(["remote", "add", "origin", url]);
    if (!remotes.includes("upstream")) {
      await this.git(["remote", "add", "upstream", upstream]);
    } else {
      const current = (await this.git(["remote", "get-url", "upstream"]).catch(() => ({ stdout: "" }))).stdout;
      if (current !== upstream) await this.git(["remote", "set-url", "upstream", upstream]);
    }

    this.logger?.info("Fetching origin and upstream");
    await this.git(["fetch", "--prune", "origin"], { timeoutMs: 300_000, retry: true });
    await this.git(["fetch", "--prune", "upstream"], { timeoutMs: 300_000, retry: true });

    const baseCheck = await this.git(["rev-parse", "--verify", `upstream/${base}`]);
    if (!baseCheck.ok) throw new Error(`Base branch upstream/${base} not found. Check ${upstream}.`);

    if (process.platform === "win32") {
      await this.git(["config", "core.longpaths", "true"]).catch(() => {});
    }

    const envFile = path.join(this.repoDir, ".env");
    const envExample = path.join(this.repoDir, ".env.example");
    if (!existsSync(envFile) && existsSync(envExample)) {
      await copyFile(envExample, envFile);
      this.logger?.info("Created .env from .env.example in the harness clone");
    }
    return this.repoDir;
  }

  async copyEnvTo(worktree: string): Promise<void> {
    for (const name of envFilesFor(this.profile)) {
      const source = path.join(this.repoDir, name);
      const target = path.join(worktree, name);
      if (existsSync(source) && !existsSync(target)) await copyFile(source, target);
    }
  }

  async baseSha(): Promise<string> {
    return (await this.git(["rev-parse", `upstream/${this.profile.repo.base}`])).stdout;
  }

  async createWorktree(branch: string, dir: string): Promise<string> {
    await mkdir(path.dirname(dir), { recursive: true });
    if (existsSync(dir)) await this.removeWorktree(dir, true).catch(() => {});
    const branches = (await this.git(["branch", "--list", branch]).catch(() => ({ stdout: "" }))).stdout;
    if (branches.includes(branch)) {
      await this.git(["worktree", "add", dir, branch]);
    } else {
      await this.git(["worktree", "add", "-b", branch, dir, `upstream/${this.profile.repo.base}`]);
    }
    await this.copyEnvTo(dir);
    return dir;
  }

  async createScratchWorktree(dir: string): Promise<string> {
    await mkdir(path.dirname(dir), { recursive: true });
    if (existsSync(dir)) await this.removeWorktree(dir, true).catch(() => {});
    await this.git(["worktree", "add", "--detach", dir, `upstream/${this.profile.repo.base}`]);
    await this.copyEnvTo(dir);
    return dir;
  }

  async createReviewWorktree(prNumber: number, dir: string): Promise<string> {
    await mkdir(path.dirname(dir), { recursive: true });
    if (existsSync(dir)) await this.removeWorktree(dir, true).catch(() => {});
    const ref = `refs/auto-work/pr-${prNumber}`;
    const fetch = await this.git(["fetch", "upstream", `pull/${prNumber}/head:${ref}`], {
      timeoutMs: 300_000,
      retry: true
    });
    if (!fetch.ok) throw new Error(fetch.stderr || "could not fetch PR head");
    await this.git(["worktree", "add", "--detach", dir, ref]);
    await this.copyEnvTo(dir);
    return dir;
  }

  async removeWorktree(dir: string, force = false): Promise<void> {
    await this.git(["worktree", "remove", ...(force ? ["--force"] : []), dir]);
    await this.git(["worktree", "prune"]).catch(() => {});
  }

  async status(worktree: string): Promise<string> {
    return (await this.git(["status", "--porcelain"], { cwd: worktree })).stdout;
  }

  async changedFiles(worktree: string): Promise<string[]> {
    const tracked = await this.git(["diff", "--name-only", `upstream/${this.profile.repo.base}`], { cwd: worktree });
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"], { cwd: worktree }).catch(() => ({
      stdout: ""
    }));
    return [...new Set([...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean))];
  }

  async diffStats(
    worktree: string,
    ref = `upstream/${this.profile.repo.base}`
  ): Promise<{ files: number; insertions: number; deletions: number; total: number }> {
    const out = await this.git(["diff", "--cached", "--numstat", ref], { cwd: worktree });
    let insertions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of out.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed] = line.split("\t");
      if (added === undefined || removed === undefined) continue;
      const add = Number(added);
      const del = Number(removed);
      if (!Number.isFinite(add) || !Number.isFinite(del)) continue;
      insertions += add;
      deletions += del;
      files += 1;
    }
    return { files, insertions, deletions, total: insertions + deletions };
  }

  async stagedChangedFiles(worktree: string, ref = `upstream/${this.profile.repo.base}`): Promise<string[]> {
    const out = await this.git(["diff", "--cached", "--name-only", ref], {
      cwd: worktree
    });
    return out.stdout.split("\n").filter(Boolean);
  }

  async headSha(worktree: string): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], { cwd: worktree })).stdout;
  }

  async commitAll(worktree: string, message: string): Promise<{ committed: boolean; sha: string; alreadyCommitted?: boolean }> {
    await this.git(["add", "-A"], { cwd: worktree });
    const status = await this.status(worktree);
    if (!status) {
      const ahead = await this.git(["rev-list", "--count", `upstream/${this.profile.repo.base}..HEAD`], {
        cwd: worktree
      }).catch(() => ({ stdout: "0" }));
      if (Number(ahead.stdout) > 0) {
        return { committed: true, sha: await this.headSha(worktree), alreadyCommitted: true };
      }
      return { committed: false, sha: await this.headSha(worktree) };
    }
    const result = await this.git(
      ["-c", "user.name=auto-work", "-c", "user.email=auto-work@users.noreply.github.com", "commit", "-m", message],
      { cwd: worktree }
    );
    if (!result.ok) throw new Error(result.stderr || result.stdout || "git commit failed");
    return { committed: true, sha: await this.headSha(worktree) };
  }

  async pushBranch(worktree: string, branch: string, options: { force?: boolean } = {}): Promise<void> {
    const args = ["push", "-u", "origin", branch, ...(options.force ? ["--force-with-lease"] : [])];
    const result = await this.git(args, {
      cwd: worktree,
      timeoutMs: requireGithubPolicy(this.profile).timeouts.fetch,
      retry: true
    });
    if (!result.ok) throw new Error(result.stderr || result.stdout || "git push failed");
  }

  async findOpenPr(branch: string): Promise<any | null> {
    const result = await this.gh([
      "pr",
      "list",
      "--repo",
      this.profile.repo.githubRepo,
      "--head",
      `${this.profile.repo.forkOwner}:${branch}`,
      "--state",
      "open",
      "--json",
      "number,url,title,state,headRefName"
    ], { retry: true, timeoutMs: requireGithubPolicy(this.profile).timeouts.view });
    if (!result.ok) return null;
    let list: any[];
    try {
      list = JSON.parse(result.stdout || "[]") as any[];
    } catch {
      // A warning line, HTML login page, or truncated body is not "no PR" —
      // but it is also not a usable answer. Treat as unknown (null) rather
      // than throwing out of every caller.
      return null;
    }
    return list[0] ?? null;
  }

  async createPr(branch: string, title: string, body: string): Promise<{ url: string; existed: boolean; branch: string }> {
    const existing = await this.findOpenPr(branch);
    if (existing?.url) return { url: existing.url, existed: true, branch };
    const result = await this.gh(
      [
        "pr",
        "create",
        "--repo",
        this.profile.repo.githubRepo,
        "--base",
        this.profile.repo.base,
        "--head",
        `${this.profile.repo.forkOwner}:${branch}`,
        "--title",
        title,
        "--body",
        body
      ],
      { timeoutMs: requireGithubPolicy(this.profile).timeouts.create }
    );
    if (!result.ok) throw new Error(result.stderr || result.stdout || "gh pr create failed");
    const url = result.stdout.split("\n").find((line) => line.startsWith("http")) || result.stdout.trim();
    return { url, existed: false, branch };
  }

  async prStatus(url: string): Promise<GitHubPrStatus> {
    const policy = requireGithubPolicy(this.profile);
    const reviewGate = this.profile.reviewGate;
    if (!reviewGate || typeof reviewGate !== "object") {
      throw new Error("profile.reviewGate is required (run `auto-work migrate`)");
    }
    const result = await this.gh([
      "pr",
      "view",
      url,
      "--json",
      "number,url,state,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName,mergeable,isDraft,statusCheckRollup,comments,reviews,reviewDecision"
    ], { retry: true, timeoutMs: policy.timeouts.view });
    if (!result.ok) throw new Error(result.stderr || result.stdout || "gh pr view failed");
    const data = JSON.parse(result.stdout) as any;
    const mergedStates = policy.stateMap.merged ?? [];
    const closedStates = policy.stateMap.closed ?? [];
    const comments = (Array.isArray(data.comments) ? data.comments : []).map((comment: any) => ({
      id: String(comment.id ?? comment.url ?? ""),
      author: String(comment.author?.login ?? comment.author?.name ?? "unknown"),
      body: String(comment.body ?? ""),
      url: typeof comment.url === "string" ? comment.url : undefined,
      createdAt: typeof comment.createdAt === "string" ? comment.createdAt : undefined,
      kind: "conversation" as const
    }));
    const reviews = (Array.isArray(data.reviews) ? data.reviews : []).map((review: any) => ({
      author: String(review.author?.login ?? review.author?.name ?? "unknown"),
      state: String(review.state ?? ""),
      body: String(review.body ?? ""),
      submittedAt: typeof review.submittedAt === "string" ? review.submittedAt : undefined
    }));
    const checkRuns = (Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : []).map((check: any) => ({
      name: String(check.name ?? check.context ?? "check"),
      status: String(check.status ?? check.state ?? ""),
      conclusion: check.conclusion ? String(check.conclusion) : null,
      url: typeof check.detailsUrl === "string" ? check.detailsUrl : typeof check.targetUrl === "string" ? check.targetUrl : undefined
    }));
    return {
      number: data.number,
      url: data.url,
      state: data.state,
      merged: mergedStates.includes(data.state) || Boolean(data.mergedAt),
      mergedInto: data.baseRefName ?? null,
      mergeCommitSha: data.mergeCommit?.oid ?? null,
      headSha: data.headRefOid ?? null,
      headRefName: data.headRefName ?? null,
      baseRefName: data.baseRefName ?? null,
      checks: summarizeChecks(data.statusCheckRollup ?? [], reviewGate.checkStates as GithubCheckStates),
      mergeable: data.mergeable === policy.mergeableMap.mergeable ? true : data.mergeable === policy.mergeableMap.conflicting ? false : null,
      reviewDecision: data.reviewDecision ?? null,
      comments,
      reviews,
      checkRuns,
      isDraft: data.isDraft
    };
  }

  private prNumber(url: string): number | null {
    const match = url.match(/\/pull\/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  async prReviewComments(url: string): Promise<Array<{ id: string; author: string; body: string; path?: string; line?: number | null; url?: string; createdAt?: string }>> {
    const number = this.prNumber(url);
    if (!number) return [];
    const result = await this.gh([
      "api",
      `repos/${this.profile.repo.githubRepo}/pulls/${number}/comments`,
      "--paginate"
    ], { timeoutMs: requireGithubPolicy(this.profile).timeouts.view, retry: true });
    if (!result.ok) return [];
    try {
      const data = JSON.parse(result.stdout) as any[];
      return data.map((comment) => ({
        id: String(comment.id ?? ""),
        author: String(comment.user?.login ?? "unknown"),
        body: String(comment.body ?? ""),
        path: typeof comment.path === "string" ? comment.path : undefined,
        line: typeof comment.line === "number" ? comment.line : typeof comment.original_line === "number" ? comment.original_line : null,
        url: typeof comment.html_url === "string" ? comment.html_url : undefined,
        createdAt: typeof comment.created_at === "string" ? comment.created_at : undefined
      }));
    } catch {
      return [];
    }
  }

  async unresolvedReviewThreads(url: string): Promise<
    Array<{ id: string; path?: string; line?: number | null; author?: string; body: string }>
  > {
    const number = this.prNumber(url);
    const [owner, repo] = this.profile.repo.githubRepo.split("/");
    if (!number || !owner || !repo) return [];
    const query = [
      "query($owner:String!,$repo:String!,$number:Int!){",
      "repository(owner:$owner,name:$repo){pullRequest(number:$number){",
      "reviewThreads(first:100){nodes{id isResolved comments(first:20){nodes{body path line author{login}}}}}}}}}"
    ].join("");
    const result = await this.gh(
      ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${number}`],
      { retry: true, timeoutMs: requireGithubPolicy(this.profile).timeouts.view }
    );
    if (!result.ok) return [];
    try {
      const data = JSON.parse(result.stdout) as any;
      const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      return nodes
        .filter((thread: any) => thread?.isResolved === false)
        .map((thread: any) => {
          const comment = thread.comments?.nodes?.[0];
          return {
            id: String(thread.id ?? ""),
            path: typeof comment?.path === "string" ? comment.path : undefined,
            line: typeof comment?.line === "number" ? comment.line : null,
            author: typeof comment?.author?.login === "string" ? comment.author.login : undefined,
            body: String(comment?.body ?? "")
          };
        })
        .filter((thread: { body: string }) => thread.body.trim());
    } catch {
      return [];
    }
  }

  async failedCheckLogs(status: GitHubPrStatus, maxRuns = 3): Promise<Array<{ name: string; log: string }>> {
    const failed = status.checkRuns
      .filter((check: PrCheck) => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes((check.conclusion ?? "").toUpperCase()))
      .slice(0, maxRuns);
    const logs: Array<{ name: string; log: string }> = [];
    for (const check of failed) {
      const runId = check.url?.match(/\/actions\/runs\/(\d+)/)?.[1];
      if (!runId) continue;
      const result = await this.gh(
        ["run", "view", runId, "--repo", this.profile.repo.githubRepo, "--log-failed"],
        { timeoutMs: requireGithubPolicy(this.profile).timeouts.view }
      ).catch(() => null);
      if (!result?.ok || !result.stdout.trim()) continue;
      const lines = result.stdout.split("\n");
      logs.push({ name: check.name, log: lines.slice(-80).join("\n").slice(-8000) });
    }
    return logs;
  }

  async updatePrBody(url: string, body: string): Promise<void> {
    const result = await this.gh(["pr", "edit", url, "--body", body], { timeoutMs: requireGithubPolicy(this.profile).timeouts.create });
    if (!result.ok) throw new Error(result.stderr || result.stdout || "gh pr edit failed");
  }

  async mergePr(url: string, method?: "merge" | "squash" | "rebase" | string): Promise<void> {
    const policy = requireGithubPolicy(this.profile);
    const resolved = method ?? policy.defaultMergeMethod;
    const flag = policy.mergeFlags[resolved];
    if (!flag) {
      throw new Error(`unknown merge method "${resolved}" (configure github.mergeFlags, run \`auto-work migrate\`)`);
    }
    const result = await this.gh(["pr", "merge", url, flag], { timeoutMs: policy.timeouts.merge, retry: true });
    if (!result.ok) throw new Error(result.stderr || result.stdout || "gh pr merge failed");
  }

  async closePr(url: string, comment?: string): Promise<void> {
    const args = ["pr", "close", url];
    if (comment) args.push("--comment", comment);
    await this.gh(args);
  }

  async authStatus() {
    return this.gh(["auth", "status"]);
  }

  async remoteAccess(url: string) {
    return this.retryCommand(() =>
      runCommand(this.profile.toolchain.git || "git", ["ls-remote", "--exit-code", url, "HEAD"], {
        timeoutMs: 60_000
      })
    );
  }
}

export const GENERIC_PR_TEMPLATE = `## Ticket

{{ticket}}

## Team lead

{{teamLead}}

## What changed

{{description}}

## Why

{{why}}

## How to test

{{howToTest}}

## What to expect

{{whatToExpect}}

## Test evidence

- Tested against: {{testedAgainst}}
- Tests: {{testResults}}

## Screenshots / recording

{{screenshots}}

## Checks

{{checks}}

## Risks / follow-ups

{{risks}}

## Notes

{{notes}}
`;

export interface PrBodyInput {
  issue: Issue;
  summary: string;
  description: string;
  testResults: string;
  testedAgainst?: string;
  howToTest?: string[];
  whatToExpect?: string;
  screenshots?: string[];
  checks?: string[];
  risks?: string[];
  notes?: string[];
}

export async function buildPrBody(profile: ProfileConfig, input: PrBodyInput): Promise<string> {
  const templateFile = resolvePrTemplate(profile);
  let template = GENERIC_PR_TEMPLATE;
  if (existsSync(templateFile)) template = await readFile(templateFile, "utf8");

  const ticket = `Ziki: ${profile.ziki.baseUrl.replace(/\/$/, "")}/${profile.ziki.projectSlug}/${input.issue.number} — ${input.issue.title}`;
  const howToTest = input.howToTest?.length
    ? input.howToTest.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "1. Check out the branch\n2. Run the project's checks";
  const values: Record<string, string> = {
    ticket,
    teamLead: profile.pr.teamLead || profile.repo.teamLead || "",
    description: input.description || input.summary || "",
    why: input.issue.summary || input.issue.title,
    howToTest,
    whatToExpect: input.whatToExpect || "The reported behaviour is fixed and existing checks pass.",
    testedAgainst: input.testedAgainst || "",
    testResults: input.testResults || "(not recorded)",
    screenshots: input.screenshots?.length ? input.screenshots.map((s) => `- ${s}`).join("\n") : "N/A",
    checks: input.checks?.length ? input.checks.map((c) => `- ${c}`).join("\n") : "",
    risks: input.risks?.length ? input.risks.map((r) => `- ${r}`).join("\n") : "",
    notes: input.notes?.length ? input.notes.map((n) => `- ${n}`).join("\n") : ""
  };
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}
