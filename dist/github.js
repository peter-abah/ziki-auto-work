import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolvePrTemplate } from "./config.js";
import { runCommand } from "./platform/spawn.js";
import { envFilesFor } from "./env.js";
export function slugify(text, max = 40) {
    const slug = String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max)
        .replace(/-+$/g, "");
    return slug || "task";
}
export function branchName(issue, title, prefix = "fix") {
    const clean = String(prefix || "fix").replace(/\/+$/, "");
    return `${clean}/${issue.number}-${slugify(title)}`;
}
export function summarizeChecks(rollup) {
    if (!rollup.length)
        return "none";
    let pending = 0;
    let failing = 0;
    for (const check of rollup) {
        const status = String(check.status ?? check.state ?? "");
        const conclusion = String(check.conclusion ?? "");
        if (["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(status))
            pending += 1;
        if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
            failing += 1;
        }
    }
    if (failing)
        return "failing";
    if (pending)
        return "pending";
    return "passing";
}
export class GitHub {
    profile;
    profileName;
    repoDir;
    logger;
    constructor(options) {
        this.profile = options.profile;
        this.profileName = options.profileName;
        this.repoDir = path.join(options.reposDir, "repo");
        this.logger = options.logger ?? null;
    }
    async git(args, options = {}) {
        return runCommand(this.profile.toolchain.git || "git", args, {
            cwd: options.cwd ?? this.repoDir,
            timeoutMs: options.timeoutMs ?? 120_000
        });
    }
    async gh(args, options = {}) {
        return runCommand(this.profile.toolchain.gh || "gh", args, {
            cwd: options.cwd ?? this.repoDir,
            timeoutMs: options.timeoutMs ?? 120_000
        });
    }
    async ensureRepo() {
        const { url, upstream, base } = this.profile.repo;
        await mkdir(this.repoDir, { recursive: true });
        if (!existsSync(path.join(this.repoDir, ".git"))) {
            this.logger?.info(`Cloning ${url} -> ${this.repoDir}`);
            const clone = await runCommand(this.profile.toolchain.git || "git", ["clone", url, this.repoDir], {
                timeoutMs: 600_000
            });
            if (!clone.ok)
                throw new Error(clone.stderr || clone.stdout || "git clone failed");
        }
        const remotes = (await this.git(["remote"]).catch(() => ({ stdout: "" }))).stdout.split(/\s+/);
        if (!remotes.includes("origin"))
            await this.git(["remote", "add", "origin", url]);
        if (!remotes.includes("upstream")) {
            await this.git(["remote", "add", "upstream", upstream]);
        }
        else {
            const current = (await this.git(["remote", "get-url", "upstream"]).catch(() => ({ stdout: "" }))).stdout;
            if (current !== upstream)
                await this.git(["remote", "set-url", "upstream", upstream]);
        }
        this.logger?.info("Fetching origin and upstream");
        await this.git(["fetch", "--prune", "origin"], { timeoutMs: 300_000 });
        await this.git(["fetch", "--prune", "upstream"], { timeoutMs: 300_000 });
        const baseCheck = await this.git(["rev-parse", "--verify", `upstream/${base}`]);
        if (!baseCheck.ok)
            throw new Error(`Base branch upstream/${base} not found. Check ${upstream}.`);
        const envFile = path.join(this.repoDir, ".env");
        const envExample = path.join(this.repoDir, ".env.example");
        if (!existsSync(envFile) && existsSync(envExample)) {
            await copyFile(envExample, envFile);
            this.logger?.info("Created .env from .env.example in the harness clone");
        }
        return this.repoDir;
    }
    async copyEnvTo(worktree) {
        for (const name of envFilesFor(this.profile)) {
            const source = path.join(this.repoDir, name);
            const target = path.join(worktree, name);
            if (existsSync(source) && !existsSync(target))
                await copyFile(source, target);
        }
    }
    async baseSha() {
        return (await this.git(["rev-parse", `upstream/${this.profile.repo.base}`])).stdout;
    }
    async createWorktree(branch, dir) {
        await mkdir(path.dirname(dir), { recursive: true });
        if (existsSync(dir))
            await this.removeWorktree(dir, true).catch(() => { });
        const branches = (await this.git(["branch", "--list", branch]).catch(() => ({ stdout: "" }))).stdout;
        if (branches.includes(branch)) {
            await this.git(["worktree", "add", dir, branch]);
        }
        else {
            await this.git(["worktree", "add", "-b", branch, dir, `upstream/${this.profile.repo.base}`]);
        }
        await this.copyEnvTo(dir);
        return dir;
    }
    async createScratchWorktree(dir) {
        await mkdir(path.dirname(dir), { recursive: true });
        if (existsSync(dir))
            await this.removeWorktree(dir, true).catch(() => { });
        await this.git(["worktree", "add", "--detach", dir, `upstream/${this.profile.repo.base}`]);
        await this.copyEnvTo(dir);
        return dir;
    }
    async createReviewWorktree(prNumber, dir) {
        await mkdir(path.dirname(dir), { recursive: true });
        if (existsSync(dir))
            await this.removeWorktree(dir, true).catch(() => { });
        const ref = `refs/auto-work/pr-${prNumber}`;
        const fetch = await this.git(["fetch", "upstream", `pull/${prNumber}/head:${ref}`], { timeoutMs: 300_000 });
        if (!fetch.ok)
            throw new Error(fetch.stderr || "could not fetch PR head");
        await this.git(["worktree", "add", "--detach", dir, ref]);
        await this.copyEnvTo(dir);
        return dir;
    }
    async removeWorktree(dir, force = false) {
        await this.git(["worktree", "remove", ...(force ? ["--force"] : []), dir]);
        await this.git(["worktree", "prune"]).catch(() => { });
    }
    async status(worktree) {
        return (await this.git(["status", "--porcelain"], { cwd: worktree })).stdout;
    }
    async changedFiles(worktree) {
        const tracked = await this.git(["diff", "--name-only", `upstream/${this.profile.repo.base}`], { cwd: worktree });
        const untracked = await this.git(["ls-files", "--others", "--exclude-standard"], { cwd: worktree }).catch(() => ({
            stdout: ""
        }));
        return [...new Set([...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean))];
    }
    async diffStats(worktree) {
        const out = await this.git(["diff", "--cached", "--numstat", `upstream/${this.profile.repo.base}`], { cwd: worktree });
        let insertions = 0;
        let deletions = 0;
        let files = 0;
        for (const line of out.stdout.split("\n")) {
            if (!line.trim())
                continue;
            const [added, removed] = line.split("\t");
            if (added === undefined || removed === undefined)
                continue;
            const add = Number(added);
            const del = Number(removed);
            if (!Number.isFinite(add) || !Number.isFinite(del))
                continue;
            insertions += add;
            deletions += del;
            files += 1;
        }
        return { files, insertions, deletions, total: insertions + deletions };
    }
    async stagedChangedFiles(worktree) {
        const out = await this.git(["diff", "--cached", "--name-only", `upstream/${this.profile.repo.base}`], {
            cwd: worktree
        });
        return out.stdout.split("\n").filter(Boolean);
    }
    async headSha(worktree) {
        return (await this.git(["rev-parse", "HEAD"], { cwd: worktree })).stdout;
    }
    async commitAll(worktree, message) {
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
        const result = await this.git(["-c", "user.name=auto-work", "-c", "user.email=auto-work@users.noreply.github.com", "commit", "-m", message], { cwd: worktree });
        if (!result.ok)
            throw new Error(result.stderr || result.stdout || "git commit failed");
        return { committed: true, sha: await this.headSha(worktree) };
    }
    async pushBranch(worktree, branch) {
        const result = await this.git(["push", "-u", "origin", branch], { cwd: worktree, timeoutMs: 300_000 });
        if (!result.ok)
            throw new Error(result.stderr || result.stdout || "git push failed");
    }
    async findOpenPr(branch) {
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
        ]);
        if (!result.ok)
            return null;
        const list = JSON.parse(result.stdout || "[]");
        return list[0] ?? null;
    }
    async createPr(branch, title, body) {
        const existing = await this.findOpenPr(branch);
        if (existing?.url)
            return { url: existing.url, existed: true, branch };
        const result = await this.gh([
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
        ], { timeoutMs: 180_000 });
        if (!result.ok)
            throw new Error(result.stderr || result.stdout || "gh pr create failed");
        const url = result.stdout.split("\n").find((line) => line.startsWith("http")) || result.stdout.trim();
        return { url, existed: false, branch };
    }
    async prStatus(url) {
        const result = await this.gh([
            "pr",
            "view",
            url,
            "--json",
            "number,url,state,mergedAt,mergeCommit,headRefOid,baseRefName,mergeable,isDraft,statusCheckRollup"
        ]);
        if (!result.ok)
            throw new Error(result.stderr || result.stdout || "gh pr view failed");
        const data = JSON.parse(result.stdout);
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
    async closePr(url, comment) {
        const args = ["pr", "close", url];
        if (comment)
            args.push("--comment", comment);
        await this.gh(args);
    }
    async authStatus() {
        return this.gh(["auth", "status"]);
    }
    async remoteAccess(url) {
        return runCommand(this.profile.toolchain.git || "git", ["ls-remote", "--exit-code", url, "HEAD"], {
            timeoutMs: 60_000
        });
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
export async function buildPrBody(profile, input) {
    const templateFile = resolvePrTemplate(profile);
    let template = GENERIC_PR_TEMPLATE;
    if (existsSync(templateFile))
        template = await readFile(templateFile, "utf8");
    const ticket = `Ziki: ${profile.ziki.baseUrl.replace(/\/$/, "")}/${profile.ziki.projectSlug}/${input.issue.number} — ${input.issue.title}`;
    const howToTest = input.howToTest?.length
        ? input.howToTest.map((step, index) => `${index + 1}. ${step}`).join("\n")
        : "1. Check out the branch\n2. Run the project's checks";
    const values = {
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
    return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => values[key] ?? "");
}
//# sourceMappingURL=github.js.map