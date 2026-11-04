import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand } from "./platform/spawn.js";
const PLATFORM_SUFFIXES = {
    desktop: ["desktop", "desktop-app", "app"],
    mobile: ["mobile", "android", "ios", "app"],
    web: ["fe", "web", "frontend", "client"]
};
export function parseRepoRef(value) {
    if (!value)
        return null;
    const trimmed = value.trim();
    const https = trimmed.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (https)
        return { owner: https[1], name: https[2] };
    const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (ssh)
        return { owner: ssh[1], name: ssh[2] };
    const plain = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (plain)
        return { owner: plain[1], name: plain[2] };
    return null;
}
export function repoName(fullName) {
    return fullName.split("/")[1] ?? fullName;
}
export function inferPlatform(name) {
    const lower = name.toLowerCase();
    if (/(^|-)desktop($|-)|-desktop-app$/.test(lower))
        return "desktop";
    if (/(^|-)mobile($|-)|-android$|-ios$/.test(lower))
        return "mobile";
    if (/(^|-)fe$|-web$|-frontend$|-client$/.test(lower))
        return "web";
    return null;
}
export function rankCandidates(candidates, slug, platform) {
    const suffixes = platform ? (PLATFORM_SUFFIXES[platform] ?? []) : [];
    const scored = candidates
        .filter((candidate) => !candidate.isArchived)
        .map((candidate) => {
        const name = repoName(candidate.fullName).toLowerCase();
        let score = 0;
        if (name === slug.toLowerCase())
            score += 60;
        if (name.startsWith(slug.toLowerCase()))
            score += 40;
        for (const suffix of suffixes) {
            if (name === `${slug.toLowerCase()}-${suffix}`)
                score += 100;
            else if (name.endsWith(`-${suffix}`))
                score += 25;
        }
        if (candidate.description?.toLowerCase().includes(slug.toLowerCase()))
            score += 10;
        if (!candidate.isFork)
            score += 5;
        score += Math.min(10, candidate.stars / 100);
        return { candidate, score };
    })
        .sort((a, b) => b.score - a.score || a.candidate.fullName.localeCompare(b.candidate.fullName));
    return scored.map((entry) => entry.candidate);
}
async function ghJson(runner, gh, args) {
    const result = await runner(gh, args, { timeoutMs: 60_000 });
    if (!result.ok)
        return null;
    try {
        return JSON.parse(result.stdout);
    }
    catch {
        return null;
    }
}
export async function githubLogin(gh = "gh", runner = runCommand) {
    const result = await runner(gh, ["api", "user", "--jq", ".login"], { timeoutMs: 60_000 });
    if (!result.ok || !result.stdout.trim())
        throw new Error("Could not determine the authenticated GitHub user. Run `gh auth login`.");
    return result.stdout.trim();
}
export async function searchRepos(slug, options = {}) {
    const gh = options.gh ?? "gh";
    const runner = options.runner ?? runCommand;
    const limit = options.limit ?? 30;
    const result = await runner(gh, [
        "search",
        "repos",
        slug,
        "--limit",
        String(limit),
        "--json",
        "fullName,url,description,isFork,isArchived,stargazersCount,updatedAt"
    ], { timeoutMs: 60_000 });
    if (!result.ok)
        return [];
    try {
        const data = JSON.parse(result.stdout);
        return data
            .filter((item) => typeof item.fullName === "string")
            .map((item) => ({
            fullName: String(item.fullName),
            url: String(item.url ?? `https://github.com/${item.fullName}`),
            sshUrl: typeof item.sshUrl === "string" ? item.sshUrl : undefined,
            description: typeof item.description === "string" ? item.description : undefined,
            isFork: item.isFork === true,
            isArchived: item.isArchived === true,
            stars: Number(item.stargazersCount ?? 0),
            updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined
        }));
    }
    catch {
        return [];
    }
}
export async function repoInfo(fullName, gh = "gh", runner = runCommand) {
    const data = await ghJson(runner, gh, ["api", `repos/${fullName}`]);
    if (!data)
        return null;
    return {
        fullName: String(data.full_name ?? fullName),
        cloneUrl: String(data.clone_url ?? `https://github.com/${fullName}.git`),
        sshUrl: typeof data.ssh_url === "string" ? data.ssh_url : undefined,
        defaultBranch: String(data.default_branch ?? "main"),
        isFork: data.fork === true,
        parent: typeof data.parent?.full_name === "string" ? data.parent.full_name : undefined,
        archived: data.archived === true
    };
}
export async function listBranches(fullName, gh = "gh", runner = runCommand) {
    const result = await runner(gh, ["api", `repos/${fullName}/branches`, "--paginate", "--jq", ".[].name"], {
        timeoutMs: 60_000
    });
    if (!result.ok)
        return [];
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
export async function gitProtocol(gh = "gh", runner = runCommand) {
    const result = await runner(gh, ["config", "get", "git_protocol"], { timeoutMs: 20_000 });
    return result.ok && result.stdout.trim() === "ssh" ? "ssh" : "https";
}
export function pickCloneUrl(info, protocol = "https") {
    if (protocol === "ssh" && info.sshUrl)
        return info.sshUrl;
    return info.cloneUrl;
}
export async function ensureFork(options) {
    const gh = options.gh ?? "gh";
    const runner = options.runner ?? runCommand;
    const upstreamOwner = options.upstream.split("/")[0] ?? "";
    const name = repoName(options.upstream);
    const protocol = await gitProtocol(gh, runner);
    const owner = options.org || options.user;
    if (upstreamOwner.toLowerCase() === owner.toLowerCase()) {
        const info = await repoInfo(options.upstream, gh, runner);
        return {
            forkOwner: owner,
            forkRepo: options.upstream,
            forkUrl: info?.cloneUrl ?? `https://github.com/${options.upstream}.git`,
            forkGitUrl: info ? pickCloneUrl(info, protocol) : `https://github.com/${options.upstream}.git`,
            exists: true,
            created: false,
            needsFork: false
        };
    }
    const forkFullName = `${owner}/${name}`;
    let info = await repoInfo(forkFullName, gh, runner);
    if (info) {
        return {
            forkOwner: owner,
            forkRepo: forkFullName,
            forkUrl: info.cloneUrl,
            forkGitUrl: pickCloneUrl(info, protocol),
            exists: true,
            created: false,
            needsFork: false
        };
    }
    if (!options.createFork) {
        return {
            forkOwner: owner,
            forkRepo: forkFullName,
            forkUrl: `https://github.com/${forkFullName}.git`,
            forkGitUrl: `https://github.com/${forkFullName}.git`,
            exists: false,
            created: false,
            needsFork: true
        };
    }
    const forkArgs = ["repo", "fork", options.upstream, "--clone=false", "--remote=false"];
    if (options.org)
        forkArgs.push("--org", options.org);
    const created = await runner(gh, forkArgs, {
        timeoutMs: 180_000
    });
    if (!created.ok)
        throw new Error(created.stderr || created.stdout || "gh repo fork failed");
    for (let attempt = 0; attempt < 5 && !info; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        info = await repoInfo(forkFullName, gh, runner);
    }
    if (!info)
        throw new Error(`Fork ${forkFullName} was created but cannot be read yet. Run the command again in a moment.`);
    return {
        forkOwner: options.user,
        forkRepo: forkFullName,
        forkUrl: info.cloneUrl,
        forkGitUrl: pickCloneUrl(info, protocol),
        exists: true,
        created: true,
        needsFork: false
    };
}
export function detectedStackAt(dir) {
    if (existsSync(path.join(dir, "pubspec.yaml")))
        return "flutter";
    if (existsSync(path.join(dir, "package.json")))
        return "node";
    if (existsSync(path.join(dir, "pyproject.toml")))
        return "python";
    if (existsSync(path.join(dir, "go.mod")))
        return "go";
    if (existsSync(path.join(dir, "Cargo.toml")))
        return "rust";
    return "generic";
}
//# sourceMappingURL=discover.js.map