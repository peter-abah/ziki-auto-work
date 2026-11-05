import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolvePrTemplate } from "./config.js";
import { runCommand } from "./platform/spawn.js";
import { envFilesFor } from "./env.js";
import { isTransientNetworkText } from "./network.js";
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
    async retryCommand(operation) {
        let last = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            last = await operation();
            if (last.ok || !isTransientNetworkText(`${last.stderr}\n${last.stdout}`))
                return last;
            if (attempt < 2)
                await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
        return last;
    }
    async git(args, options = {}) {
        const run = () => runCommand(this.profile.toolchain.git || "git", args, {
            cwd: options.cwd ?? this.repoDir,
            timeoutMs: options.timeoutMs ?? 120_000
        });
        return options.retry ? this.retryCommand(run) : run();
    }
    async gh(args, options = {}) {
        const run = () => runCommand(this.profile.toolchain.gh || "gh", args, {
            cwd: options.cwd ?? this.repoDir,
            timeoutMs: options.timeoutMs ?? 120_000
        });
        return options.retry ? this.retryCommand(run) : run();
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
        await this.git(["fetch", "--prune", "origin"], { timeoutMs: 300_000, retry: true });
        await this.git(["fetch", "--prune", "upstream"], { timeoutMs: 300_000, retry: true });
        const baseCheck = await this.git(["rev-parse", "--verify", `upstream/${base}`]);
        if (!baseCheck.ok)
            throw new Error(`Base branch upstream/${base} not found. Check ${upstream}.`);
        if (process.platform === "win32") {
            await this.git(["config", "core.longpaths", "true"]).catch(() => { });
        }
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
        const fetch = await this.git(["fetch", "upstream", `pull/${prNumber}/head:${ref}`], {
            timeoutMs: 300_000,
            retry: true
        });
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
    async diffStats(worktree, ref = `upstream/${this.profile.repo.base}`) {
        const out = await this.git(["diff", "--cached", "--numstat", ref], { cwd: worktree });
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
    async stagedChangedFiles(worktree, ref = `upstream/${this.profile.repo.base}`) {
        const out = await this.git(["diff", "--cached", "--name-only", ref], {
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
    async pushBranch(worktree, branch, options = {}) {
        const args = ["push", "-u", "origin", branch, ...(options.force ? ["--force-with-lease"] : [])];
        const result = await this.git(args, {
            cwd: worktree,
            timeoutMs: 300_000,
            retry: true
        });
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
        ], { retry: true });
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
            "number,url,state,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName,mergeable,isDraft,statusCheckRollup,comments,reviews,reviewDecision"
        ], { retry: true });
        if (!result.ok)
            throw new Error(result.stderr || result.stdout || "gh pr view failed");
        const data = JSON.parse(result.stdout);
        const comments = (Array.isArray(data.comments) ? data.comments : []).map((comment) => ({
            id: String(comment.id ?? comment.url ?? ""),
            author: String(comment.author?.login ?? comment.author?.name ?? "unknown"),
            body: String(comment.body ?? ""),
            url: typeof comment.url === "string" ? comment.url : undefined,
            createdAt: typeof comment.createdAt === "string" ? comment.createdAt : undefined,
            kind: "conversation"
        }));
        const reviews = (Array.isArray(data.reviews) ? data.reviews : []).map((review) => ({
            author: String(review.author?.login ?? review.author?.name ?? "unknown"),
            state: String(review.state ?? ""),
            body: String(review.body ?? ""),
            submittedAt: typeof review.submittedAt === "string" ? review.submittedAt : undefined
        }));
        const checkRuns = (Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : []).map((check) => ({
            name: String(check.name ?? check.context ?? "check"),
            status: String(check.status ?? check.state ?? ""),
            conclusion: check.conclusion ? String(check.conclusion) : null,
            url: typeof check.detailsUrl === "string" ? check.detailsUrl : typeof check.targetUrl === "string" ? check.targetUrl : undefined
        }));
        return {
            number: data.number,
            url: data.url,
            state: data.state,
            merged: data.state === "MERGED" || Boolean(data.mergedAt),
            mergedInto: data.baseRefName ?? null,
            mergeCommitSha: data.mergeCommit?.oid ?? null,
            headSha: data.headRefOid ?? null,
            headRefName: data.headRefName ?? null,
            baseRefName: data.baseRefName ?? null,
            checks: summarizeChecks(data.statusCheckRollup ?? []),
            mergeable: data.mergeable === "MERGEABLE" ? true : data.mergeable === "CONFLICTING" ? false : null,
            reviewDecision: data.reviewDecision ?? null,
            comments,
            reviews,
            checkRuns,
            isDraft: data.isDraft
        };
    }
    prNumber(url) {
        const match = url.match(/\/pull\/(\d+)/);
        return match ? Number(match[1]) : null;
    }
    async prReviewComments(url) {
        const number = this.prNumber(url);
        if (!number)
            return [];
        const result = await this.gh([
            "api",
            `repos/${this.profile.repo.githubRepo}/pulls/${number}/comments`,
            "--paginate"
        ], { timeoutMs: 120_000, retry: true });
        if (!result.ok)
            return [];
        try {
            const data = JSON.parse(result.stdout);
            return data.map((comment) => ({
                id: String(comment.id ?? ""),
                author: String(comment.user?.login ?? "unknown"),
                body: String(comment.body ?? ""),
                path: typeof comment.path === "string" ? comment.path : undefined,
                line: typeof comment.line === "number" ? comment.line : typeof comment.original_line === "number" ? comment.original_line : null,
                url: typeof comment.html_url === "string" ? comment.html_url : undefined,
                createdAt: typeof comment.created_at === "string" ? comment.created_at : undefined
            }));
        }
        catch {
            return [];
        }
    }
    async failedCheckLogs(status, maxRuns = 3) {
        const failed = status.checkRuns
            .filter((check) => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes((check.conclusion ?? "").toUpperCase()))
            .slice(0, maxRuns);
        const logs = [];
        for (const check of failed) {
            const runId = check.url?.match(/\/actions\/runs\/(\d+)/)?.[1];
            if (!runId)
                continue;
            const result = await this.gh(["run", "view", runId, "--repo", this.profile.repo.githubRepo, "--log-failed"], { timeoutMs: 120_000 }).catch(() => null);
            if (!result?.ok || !result.stdout.trim())
                continue;
            const lines = result.stdout.split("\n");
            logs.push({ name: check.name, log: lines.slice(-80).join("\n").slice(-8000) });
        }
        return logs;
    }
    async updatePrBody(url, body) {
        const result = await this.gh(["pr", "edit", url, "--body", body], { timeoutMs: 120_000 });
        if (!result.ok)
            throw new Error(result.stderr || result.stdout || "gh pr edit failed");
    }
    async mergePr(url, method = "squash") {
        const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
        const result = await this.gh(["pr", "merge", url, flag], { timeoutMs: 300_000, retry: true });
        if (!result.ok)
            throw new Error(result.stderr || result.stdout || "gh pr merge failed");
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
        return this.retryCommand(() => runCommand(this.profile.toolchain.git || "git", ["ls-remote", "--exit-code", url, "HEAD"], {
            timeoutMs: 60_000
        }));
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