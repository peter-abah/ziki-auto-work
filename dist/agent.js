import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveModel, resolvePromptDir } from "./config.js";
import { getProvider } from "./providers/index.js";
import { PACKAGE_ROOT } from "./platform/paths.js";
import { spawnCommand } from "./platform/spawn.js";
import { killProcessTree } from "./platform/process.js";
import { issueUrl, ideaUrl } from "./urls.js";
import { resolveCommand } from "./checks.js";
import { buildAgentEnv } from "./env.js";
import { formatPrFieldMap, formatProtectedFiles, formatWorkflowRules, loadPrTemplateText } from "./rules.js";
import { truncate } from "./log.js";
const activeChildren = new Set();
export function killActiveAgents() {
    for (const child of activeChildren) {
        killProcessTree(child.pid);
    }
}
export function activeAgentPids() {
    return [...activeChildren].map((child) => child.pid).filter((pid) => Boolean(pid));
}
export function render(template, vars) {
    return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
        const value = vars[key];
        return value === undefined || value === null ? "" : String(value);
    });
}
export async function loadPrompt(profile, role) {
    const dir = resolvePromptDir(profile);
    const primary = path.join(dir, `${role}.md`);
    if (existsSync(primary))
        return readFile(primary, "utf8");
    const fallback = path.join(PACKAGE_ROOT, "prompts", "generic", `${role}.md`);
    if (existsSync(fallback))
        return readFile(fallback, "utf8");
    throw new Error(`Prompt "${role}.md" not found in ${dir}`);
}
function resultPaths(profilePaths, kind, label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, "-");
    const base = `${kind}-${safeLabel}-${stamp}`;
    return {
        resultPath: path.join(profilePaths.resultsDir, `${base}.json`),
        logPath: path.join(profilePaths.logsDir, "agents", `${base}.log`)
    };
}
export async function runAgent(options) {
    const { profile, profilePaths, role, prompt, cwd, resultPath, logPath, logger } = options;
    const model = resolveModel(profile, role);
    const provider = getProvider(profile.executor.provider, profile);
    const command = provider.build({ prompt, cwd, resultPath, model });
    const limit = options.timeoutMs ?? profile.executor.timeoutMs ?? 45 * 60 * 1000;
    await mkdir(path.dirname(resultPath), { recursive: true });
    await mkdir(path.dirname(logPath), { recursive: true });
    const stream = createWriteStream(logPath, { flags: "a" });
    let tail = "";
    logger?.info(`Starting ${role} agent`, {
        provider: profile.executor.provider,
        model: model ?? "(provider default)",
        cwd,
        logPath
    });
    const child = spawnCommand(command.command, command.args, {
        cwd,
        env: {
            ...buildAgentEnv(profile, command.env, options.extraEnv),
            AW_RESULT_PATH: resultPath,
            AW_ROLE: role,
            AW_PROFILE: profile.ziki.projectSlug
        }
    });
    activeChildren.add(child);
    if (child.pid)
        options.onSpawn?.(child.pid);
    if (command.stdin !== undefined) {
        child.stdin?.write(command.stdin);
    }
    child.stdin?.end();
    const capture = (chunk) => {
        const text = chunk.toString();
        stream.write(text);
        tail = (tail + text).slice(-20_000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
    }, limit);
    const exit = await new Promise((resolve) => {
        child.on("error", (error) => resolve({ code: -1, error }));
        child.on("close", (code, signal) => resolve({ code: code ?? -1, signal: signal ?? undefined }));
    });
    activeChildren.delete(child);
    if (child.pid)
        options.onExit?.(child.pid);
    clearTimeout(timer);
    stream.end();
    if (timedOut) {
        return { ok: false, error: `agent timed out after ${Math.round(limit / 60000)} min`, logPath, tail: truncate(tail, 2000) };
    }
    if (exit.error) {
        return { ok: false, error: `agent failed to start: ${exit.error.message}`, logPath, tail: truncate(tail, 2000) };
    }
    if (!existsSync(resultPath)) {
        return {
            ok: false,
            error: `agent exited (${exit.code}) without writing ${resultPath}`,
            logPath,
            tail: truncate(tail, 3000)
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(await readFile(resultPath, "utf8"));
    }
    catch (error) {
        return {
            ok: false,
            error: `result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            logPath,
            tail: truncate(tail, 2000)
        };
    }
    return {
        ...parsed,
        ok: parsed.ok === true && parsed.blocked !== true,
        blocked: parsed.blocked === true,
        exitCode: exit.code,
        logPath,
        tail: truncate(tail, 3000)
    };
}
export function checksText(profile) {
    if (!profile.checks.length)
        return "(no checks configured)";
    return profile.checks
        .map((check) => {
        const command = resolveCommand(profile, check.command);
        return `- ${check.name}: \`${command} ${check.args.join(" ")}\``;
    })
        .join("\n");
}
export function projectName(profile) {
    return profile.ziki.projectName || profile.ziki.projectSlug;
}
export async function runWorker(options) {
    const { profile, profilePaths, issue, memoryText, worktree, branch, base, logger } = options;
    const { resultPath, logPath } = resultPaths(profilePaths, "worker", issue.number);
    const template = await loadPrompt(profile, "worker");
    const workflowRules = formatWorkflowRules(profile, { branch });
    const prTemplate = await loadPrTemplateText(profile);
    const prompt = render(template, {
        projectName: projectName(profile),
        stack: profile.stack || profile.ziki.platform,
        repoUrl: profile.repo.githubRepo,
        githubRepo: profile.repo.githubRepo,
        forkOwner: profile.repo.forkOwner,
        prBase: profile.repo.base,
        teamLead: profile.pr.teamLead || profile.repo.teamLead || "",
        base,
        platform: profile.ziki.platform,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueId: issue.id,
        issueUrl: issueUrl(profile, issue),
        issueSummary: issue.summary || "",
        issueDescription: issue.description || "",
        issueStatus: issue.status,
        issueSubstatus: issue.substatus,
        issueContext: options.issueContext || "(none)",
        previousError: options.previousError || "(none)",
        memory: memoryText,
        checks: checksText(profile),
        workflowRules,
        protectedFiles: formatProtectedFiles(profile),
        maxFiles: profile.workflow.maxFiles,
        maxLines: profile.workflow.maxLines,
        branchPrefix: profile.workflow.branchPrefix,
        commitTypes: profile.workflow.commitTypes.join(", "),
        prTemplate,
        prFieldMap: formatPrFieldMap(),
        worktree,
        branch,
        resultPath,
        logPath
    });
    return runAgent({ profile, profilePaths, role: "worker", prompt, cwd: worktree, resultPath, logPath, logger, onSpawn: options.onSpawn, onExit: options.onExit });
}
export async function runDiscovery(options) {
    const { profile, profilePaths, memoryText, repoDir, parity, existingIssues, maxIdeas, logger } = options;
    const { resultPath, logPath } = resultPaths(profilePaths, "discovery", "parity");
    const template = await loadPrompt(profile, "discovery");
    const prompt = render(template, {
        projectName: projectName(profile),
        stack: profile.stack || profile.ziki.platform,
        repoUrl: profile.repo.githubRepo,
        repoDir,
        platform: profile.ziki.platform,
        parity,
        existingIssues,
        maxIdeas,
        memory: memoryText,
        checks: checksText(profile),
        resultPath,
        logPath
    });
    return runAgent({
        profile,
        profilePaths,
        role: "discovery",
        prompt,
        cwd: repoDir,
        resultPath,
        logPath,
        logger,
        timeoutMs: 45 * 60 * 1000,
        onSpawn: options.onSpawn,
        onExit: options.onExit
    });
}
export async function runReview(options) {
    const { profile, profilePaths, issue, memoryText, worktree, prUrl, headSha, logger } = options;
    const { resultPath, logPath } = resultPaths(profilePaths, "review", issue.number);
    const template = await loadPrompt(profile, "review");
    const prompt = render(template, {
        projectName: projectName(profile),
        stack: profile.stack || profile.ziki.platform,
        repoUrl: profile.repo.githubRepo,
        base: profile.repo.base,
        platform: profile.ziki.platform,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issueUrl(profile, issue),
        issueDescription: issue.description || "",
        memory: memoryText,
        checks: checksText(profile),
        workflowRules: formatWorkflowRules(profile),
        protectedFiles: formatProtectedFiles(profile),
        worktree,
        prUrl,
        headSha,
        resultPath,
        logPath
    });
    return runAgent({ profile, profilePaths, role: "review", prompt, cwd: worktree, resultPath, logPath, logger, onSpawn: options.onSpawn, onExit: options.onExit });
}
export async function runConfirm(options) {
    const { profile, profilePaths, issue, memoryText, repoDir, logger } = options;
    const { resultPath, logPath } = resultPaths(profilePaths, "confirm", issue.number);
    const template = await loadPrompt(profile, "confirm");
    const prompt = render(template, {
        projectName: projectName(profile),
        stack: profile.stack || profile.ziki.platform,
        repoUrl: profile.repo.githubRepo,
        repoDir,
        platform: profile.ziki.platform,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issueUrl(profile, issue),
        issueSummary: issue.summary || "",
        issueDescription: issue.description || "",
        memory: memoryText,
        checks: checksText(profile),
        workflowRules: formatWorkflowRules(profile),
        protectedFiles: formatProtectedFiles(profile),
        resultPath,
        logPath
    });
    return runAgent({ profile, profilePaths, role: "confirm", prompt, cwd: repoDir, resultPath, logPath, logger, onSpawn: options.onSpawn, onExit: options.onExit });
}
export async function runTriage(options) {
    const { profile, profilePaths, idea, memoryText, repoDir, logger } = options;
    const { resultPath, logPath } = resultPaths(profilePaths, "triage", idea.number);
    const template = await loadPrompt(profile, "triage");
    const prompt = render(template, {
        projectName: projectName(profile),
        stack: profile.stack || profile.ziki.platform,
        repoUrl: profile.repo.githubRepo,
        repoDir,
        platform: profile.ziki.platform,
        ideaNumber: idea.number,
        ideaTitle: idea.title,
        ideaUrl: ideaUrl(profile, idea),
        ideaSummary: idea.summary || "",
        ideaDescription: idea.description || "",
        memory: memoryText,
        checks: checksText(profile),
        workflowRules: formatWorkflowRules(profile),
        protectedFiles: formatProtectedFiles(profile),
        resultPath,
        logPath
    });
    return runAgent({
        profile,
        profilePaths,
        role: "triage",
        prompt,
        cwd: repoDir,
        resultPath,
        logPath,
        logger,
        timeoutMs: 20 * 60 * 1000,
        onSpawn: options.onSpawn,
        onExit: options.onExit
    });
}
export async function runOwner(options) {
    const { profile, profilePaths, request, memoryText, repoDir, logger } = options;
    const { resultPath, logPath } = resultPaths(profilePaths, "owner", request.id || "request");
    const template = await loadPrompt(profile, "owner");
    const prompt = render(template, {
        projectName: projectName(profile),
        stack: profile.stack || profile.ziki.platform,
        repoUrl: profile.repo.githubRepo,
        repoDir,
        request: request.body,
        memory: memoryText,
        checks: checksText(profile),
        resultPath,
        logPath
    });
    return runAgent({
        profile,
        profilePaths,
        role: "owner",
        prompt,
        cwd: repoDir,
        resultPath,
        logPath,
        logger,
        timeoutMs: 30 * 60 * 1000,
        onSpawn: options.onSpawn,
        onExit: options.onExit
    });
}
//# sourceMappingURL=agent.js.map