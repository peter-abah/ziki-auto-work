import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentResult, Idea, Issue, ProfileConfig, ProfilePaths, Role } from "./types.js";
import { resolveModel, resolvePromptDir } from "./config.js";
import { getProvider } from "./providers/index.js";
import { PACKAGE_ROOT } from "./platform/paths.js";
import { spawnCommand } from "./platform/spawn.js";
import { issueUrl, ideaUrl } from "./urls.js";
import { truncate } from "./log.js";
import type { Logger } from "./log.js";

const activeChildren = new Set<ReturnType<typeof spawnCommand>>();

export function killActiveAgents(): void {
  for (const child of activeChildren) {
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export async function loadPrompt(profile: ProfileConfig, role: Role | "pr"): Promise<string> {
  const dir = resolvePromptDir(profile);
  const primary = path.join(dir, `${role}.md`);
  if (existsSync(primary)) return readFile(primary, "utf8");
  const fallback = path.join(PACKAGE_ROOT, "prompts", "generic", `${role}.md`);
  if (existsSync(fallback)) return readFile(fallback, "utf8");
  throw new Error(`Prompt "${role}.md" not found in ${dir}`);
}

function resultPaths(profilePaths: ProfilePaths, kind: string, label: string | number): { resultPath: string; logPath: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, "-");
  const base = `${kind}-${safeLabel}-${stamp}`;
  return {
    resultPath: path.join(profilePaths.resultsDir, `${base}.json`),
    logPath: path.join(profilePaths.logsDir, "agents", `${base}.log`)
  };
}

export async function runAgent(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  role: Role;
  prompt: string;
  cwd: string;
  resultPath: string;
  logPath: string;
  logger?: Logger;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}): Promise<AgentResult> {
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
      ...command.env,
      ...options.extraEnv,
      AW_RESULT_PATH: resultPath,
      AW_ROLE: role,
      AW_PROFILE: profile.ziki.projectSlug
    }
  });
  activeChildren.add(child);

  if (command.stdin !== undefined) {
    child.stdin?.write(command.stdin);
  }
  child.stdin?.end();

  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    stream.write(text);
    tail = (tail + text).slice(-20_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }, limit);

  const exit = await new Promise<{ code: number; signal?: string; error?: Error }>((resolve) => {
    child.on("error", (error) => resolve({ code: -1, error }));
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal: signal ?? undefined }));
  });
  activeChildren.delete(child);
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

  let parsed: AgentResult;
  try {
    parsed = JSON.parse(await readFile(resultPath, "utf8")) as AgentResult;
  } catch (error) {
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

export function checksText(profile: ProfileConfig): string {
  if (!profile.checks.length) return "(no checks configured)";
  return profile.checks
    .map((check) => `- ${check.name}: \`${check.command} ${check.args.join(" ")}\``)
    .join("\n");
}

export function projectName(profile: ProfileConfig): string {
  return profile.ziki.projectName || profile.ziki.projectSlug;
}

export async function runWorker(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  worktree: string;
  branch: string;
  base: string;
  previousError?: string;
  issueContext?: string;
  logger?: Logger;
}): Promise<AgentResult> {
  const { profile, profilePaths, issue, memoryText, worktree, branch, base, logger } = options;
  const { resultPath, logPath } = resultPaths(profilePaths, "worker", issue.number);
  const template = await loadPrompt(profile, "worker");
  const prompt = render(template, {
    projectName: projectName(profile),
    stack: profile.stack || profile.ziki.platform,
    repoUrl: profile.repo.githubRepo,
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
    worktree,
    branch,
    resultPath,
    logPath
  });
  return runAgent({ profile, profilePaths, role: "worker", prompt, cwd: worktree, resultPath, logPath, logger });
}

export async function runDiscovery(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  memoryText: string;
  repoDir: string;
  parity: string;
  existingIssues: string;
  maxIdeas: number;
  logger?: Logger;
}): Promise<AgentResult> {
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
    timeoutMs: 45 * 60 * 1000
  });
}

export async function runReview(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  worktree: string;
  prUrl: string;
  headSha: string;
  logger?: Logger;
}): Promise<AgentResult> {
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
    worktree,
    prUrl,
    headSha,
    resultPath,
    logPath
  });
  return runAgent({ profile, profilePaths, role: "review", prompt, cwd: worktree, resultPath, logPath, logger });
}

export async function runConfirm(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  repoDir: string;
  logger?: Logger;
}): Promise<AgentResult> {
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
    resultPath,
    logPath
  });
  return runAgent({ profile, profilePaths, role: "confirm", prompt, cwd: repoDir, resultPath, logPath, logger });
}

export async function runTriage(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  idea: Idea;
  memoryText: string;
  repoDir: string;
  logger?: Logger;
}): Promise<AgentResult> {
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
    timeoutMs: 20 * 60 * 1000
  });
}

export async function runOwner(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  request: { id: string; body: string };
  memoryText: string;
  repoDir: string;
  logger?: Logger;
}): Promise<AgentResult> {
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
    timeoutMs: 30 * 60 * 1000
  });
}
