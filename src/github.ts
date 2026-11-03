import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Issue, JobConfig } from "./types.js";
import { resolvePrTemplate } from "./config.js";
import { runCommand } from "./platform/spawn.js";

export function slugify(text: string, max = 40): string {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function branchName(issue: { number: number | string }, title: string): string {
  return `fix/${issue.number}-${slugify(title)}`;
}

export function summarizeChecks(rollup: Array<Record<string, unknown>>): "passing" | "failing" | "pending" | "none" {
  if (!rollup.length) return "none";
  let pending = 0;
  let failing = 0;
  for (const check of rollup) {
    const status = String(check.status ?? check.state ?? "");
    const conclusion = String(check.conclusion ?? "");
    if (["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(status)) pending += 1;
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
      failing += 1;
    }
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

export interface GitHubPrStatus {
  number?: number;
  url: string;
  state: string;
  merged: boolean;
  mergedInto: string | null;
  mergeCommitSha: string | null;
  headSha: string | null;
  checks: "passing" | "failing" | "pending" | "none";
  mergeable: boolean | null;
  isDraft?: boolean;
}

export class GitHub {
  job: JobConfig;
  jobName: string;
  repoDir: string;
  logger: { info: (m: string, f?: Record<string, unknown>) => Promise<void>; warn: (m: string, f?: Record<string, unknown>) => Promise<void> } | null;

  constructor(options: {
    job: JobConfig;
    jobName: string;
    reposDir: string;
    logger?: GitHub["logger"];
  }) {
    this.job = options.job;
    this.jobName = options.jobName;
    this.repoDir = path.join(options.reposDir, "repo");
    this.logger = options.logger ?? null;
  }

  async git(args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
    return runCommand(this.job.toolchain.git || "git", args, {
      cwd: options.cwd ?? this.repoDir,
      timeoutMs: options.timeoutMs ?? 120_000
    });
  }

  async gh(args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
    return runCommand(this.job.toolchain.gh || "gh", args, {
      cwd: options.cwd ?? this.repoDir,
      timeoutMs: options.timeoutMs ?? 120_000
    });
  }

  async ensureRepo(): Promise<string> {
    const { url, upstream, base } = this.job.repo;
    await mkdir(this.repoDir, { recursive: true });
    if (!existsSync(path.join(this.repoDir, ".git"))) {
      this.logger?.info(`Cloning ${url} -> ${this.repoDir}`);
      const clone = await runCommand(this.job.toolchain.git || "git", ["clone", url, this.repoDir], {
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
    await this.git(["fetch", "--prune", "origin"], { timeoutMs: 300_000 });
    await this.git(["fetch", "--prune", "upstream"], { timeoutMs: 300_000 });

    const baseCheck = await this.git(["rev-parse", "--verify", `upstream/${base}`]);
    if (!baseCheck.ok) throw new Error(`Base branch upstream/${base} not found. Check ${upstream}.`);

    const envFile = path.join(this.repoDir, ".env");
    const envExample = path.join(this.repoDir, ".env.example");
    if (!existsSync(envFile) && existsSync(envExample)) {
      await copyFile(envExample, envFile);
      this.logger?.info("Created .env from .env.example in the harness clone");
    }
    return this.repoDir;
  }

  async copyEnvTo(worktree: string): Promise<void> {
    const source = path.join(this.repoDir, ".env");
    const target = path.join(worktree, ".env");
    if (existsSync(source) && !existsSync(target)) await copyFile(source, target);
  }

  async baseSha(): Promise<string> {
    return (await this.git(["rev-parse", `upstream/${this.job.repo.base}`])).stdout;
  }

  async createWorktree(branch: string, dir: string): Promise<string> {
    await mkdir(path.dirname(dir), { recursive: true });
    if (existsSync(dir)) await this.removeWorktree(dir, true).catch(() => {});
    const branches = (await this.git(["branch", "--list", branch]).catch(() => ({ stdout: "" }))).stdout;
    if (branches.includes(branch)) {
      await this.git(["worktree", "add", dir, branch]);
    } else {
      await this.git(["worktree", "add", "-b", branch, dir, `upstream/${this.job.repo.base}`]);
    }
    await this.copyEnvTo(dir);
    return dir;
  }

  async createScratchWorktree(dir: string): Promise<string> {
    await mkdir(path.dirname(dir), { recursive: true });
    if (existsSync(dir)) await this.removeWorktree(dir, true).catch(() => {});
    await this.git(["worktree", "add", "--detach", dir, `upstream/${this.job.repo.base}`]);
    await this.copyEnvTo(dir);
    return dir;
  }

  async createReviewWorktree(prNumber: number, dir: string): Promise<string> {
    await mkdir(path.dirname(dir), { recursive: true });
    if (existsSync(dir)) await this.removeWorktree(dir, true).catch(() => {});
    const ref = `refs/auto-work/pr-${prNumber}`;
    const fetch = await this.git(["fetch", "upstream", `pull/${prNumber}/head:${ref}`], { timeoutMs: 300_000 });
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
    const tracked = await this.git(["diff", "--name-only", `upstream/${this.job.repo.base}`], { cwd: worktree });
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"], { cwd: worktree }).catch(() => ({
      stdout: ""
    }));
    return [...new Set([...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean))];
  }

  async stagedChangedFiles(worktree: string): Promise<string[]> {
    const out = await this.git(["diff", "--cached", "--name-only", `upstream/${this.job.repo.base}`], {
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
      const ahead = await this.git(["rev-list", "--count", `upstream/${this.job.repo.base}..HEAD`], {
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

  async pushBranch(worktree: string, branch: string): Promise<void> {
    const result = await this.git(["push", "-u", "origin", branch], { cwd: worktree, timeoutMs: 300_000 });
    if (!result.ok) throw new Error(result.stderr || result.stdout || "git push failed");
  }

  async findOpenPr(branch: string): Promise<any | null> {
    const result = await this.gh([
      "pr",
      "list",
      "--repo",
      this.job.repo.githubRepo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,title,state,headRefName"
    ]);
    if (!result.ok) return null;
    const list = JSON.parse(result.stdout || "[]") as any[];
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
        this.job.repo.githubRepo,
        "--base",
        this.job.repo.base,
        "--head",
        `${this.job.repo.forkOwner}:${branch}`,
        "--title",
        title,
        "--body",
        body
      ],
      { timeoutMs: 180_000 }
    );
    if (!result.ok) throw new Error(result.stderr || result.stdout || "gh pr create failed");
    const url = result.stdout.split("\n").find((line) => line.startsWith("http")) || result.stdout.trim();
    return { url, existed: false, branch };
  }

  async prStatus(url: string): Promise<GitHubPrStatus> {
    const result = await this.gh([
      "pr",
      "view",
      url,
      "--json",
      "number,url,state,mergedAt,mergeCommit,headRefOid,baseRefName,mergeable,isDraft,statusCheckRollup"
    ]);
    if (!result.ok) throw new Error(result.stderr || result.stdout || "gh pr view failed");
    const data = JSON.parse(result.stdout) as any;
    return {
      number: data.number,
      url: data.url,
      state: data.state,
      merged: data.state === "MERGED",
      mergedInto: data.baseRefName ?? null,
      mergeCommitSha: data.mergeCommit?.oid ?? null,
      headSha: data.headRefOid ?? null,
      checks: summarizeChecks(data.statusCheckRollup ?? []),
      mergeable: data.mergeable === "MERGEABLE" ? true : data.mergeable === "CONFLICTING" ? false : null,
      isDraft: data.isDraft
    };
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
    return runCommand(this.job.toolchain.git || "git", ["ls-remote", "--exit-code", url, "HEAD"], {
      timeoutMs: 60_000
    });
  }
}

const GENERIC_PR_TEMPLATE = `## Ticket

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

export async function buildPrBody(job: JobConfig, input: PrBodyInput): Promise<string> {
  const templateFile = resolvePrTemplate(job);
  let template = GENERIC_PR_TEMPLATE;
  if (existsSync(templateFile)) template = await readFile(templateFile, "utf8");

  const ticket = `Ziki: ${job.ziki.baseUrl.replace(/\/$/, "")}/${job.ziki.projectSlug}/${input.issue.number} — ${input.issue.title}`;
  const howToTest = input.howToTest?.length
    ? input.howToTest.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "1. Check out the branch\n2. Run the project's checks";
  const values: Record<string, string> = {
    ticket,
    teamLead: job.pr.teamLead || job.repo.teamLead || "",
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
