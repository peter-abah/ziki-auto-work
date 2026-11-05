import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentResult, Idea, Issue, ProfileConfig, ProfilePaths, Role } from "./types.js";
import { resolveModel, resolvePromptDir } from "./config.js";
import { getProvider } from "./providers/index.js";
import { PACKAGE_ROOT } from "./platform/paths.js";
import { spawnCommand } from "./platform/spawn.js";
import { killProcessTree } from "./platform/process.js";
import { issueUrl, ideaUrl } from "./urls.js";
import { resolveCommand } from "./checks.js";
import { buildAgentEnv } from "./env.js";
import { providerLimitForResult } from "./provider-errors.js";
import { parseUsage } from "./usage.js";
import {
  formatPrFieldMap,
  formatProtectedFiles,
  formatWorkflowRules,
  loadPrTemplateText
} from "./rules.js";
import { truncate } from "./log.js";
import type { Logger } from "./log.js";

const activeChildren = new Set<ReturnType<typeof spawnCommand>>();

export function killActiveAgents(): void {
  for (const child of activeChildren) {
    killProcessTree(child.pid);
  }
}

export function activeAgentPids(): number[] {
  return [...activeChildren].map((child) => child.pid).filter((pid): pid is number => Boolean(pid));
}

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

const PROMPT_FILES: Partial<Record<Role | "pr", string>> = {
  stakeVote: "stake-vote",
  senseCheck: "sense-check",
  jobReview: "job-review",
  bidVote: "bid-vote",
  commentVote: "comment-vote"
};

export async function loadPrompt(profile: ProfileConfig, role: Role | "pr"): Promise<string> {
  const dir = resolvePromptDir(profile);
  const name = PROMPT_FILES[role] ?? role;
  const primary = path.join(dir, `${name}.md`);
  if (existsSync(primary)) return readFile(primary, "utf8");
  const fallback = path.join(PACKAGE_ROOT, "prompts", "generic", `${name}.md`);
  if (existsSync(fallback)) return readFile(fallback, "utf8");
  throw new Error(`Prompt "${name}.md" not found in ${dir}`);
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

export function extractJsonResult(text: string): AgentResult | null {
  const marker = "AW_RESULT_JSON:";
  const markerAt = text.lastIndexOf(marker);
  if (markerAt >= 0) {
    const candidate = text.slice(markerAt + marker.length).trim();
    const end = candidate.lastIndexOf("}");
    if (end >= 0) {
      try {
        const parsed = JSON.parse(candidate.slice(0, end + 1)) as AgentResult;
        if (parsed && typeof parsed === "object" && ("ok" in parsed || "blocked" in parsed || "summary" in parsed)) {
          return parsed;
        }
      } catch {
        // fall through to the compatibility parser
      }
    }
  }
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? "").reverse();
  const candidates = [...fenced];
  for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
    candidates.push(text.slice(index));
    if (candidates.length > 300) break;
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const end = trimmed.lastIndexOf("}");
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(0, end + 1)) as AgentResult;
      if (parsed && typeof parsed === "object" && ("ok" in parsed || "blocked" in parsed || "summary" in parsed)) {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
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
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  const { profile, profilePaths, role, prompt, cwd, resultPath, logPath, logger } = options;
  const model = resolveModel(profile, role);
  const provider = getProvider(profile.executor.provider, profile);
  const resultMode = provider.resultMode ?? "file";
  const explicitSignals = [
    "## Explicit result signals",
    "",
    "Only set `providerLimit` to `\"quota\"`, `\"rate-limit\"` or `\"context\"` when the provider itself explicitly reports that failure on a failed run.",
    "Only set `environmentHint` when a required command, environment value or authentication prerequisite is genuinely missing.",
    "Never infer either field from source code, logs, line numbers, token counts or tool output. When unsure, leave them out.",
    resultMode === "stdout"
      ? "Print the final result as a single line beginning with `AW_RESULT_JSON:` followed by the JSON object."
      : ""
  ]
    .filter(Boolean)
    .join("\n");
  const command = provider.build({ prompt: `${prompt}\n\n${explicitSignals}`, cwd, resultPath, model });
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
  if (child.pid) options.onSpawn?.(child.pid);

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
    killProcessTree(child.pid);
  }, limit);

  const exit = await new Promise<{ code: number; signal?: string; error?: Error }>((resolve) => {
    child.on("error", (error) => resolve({ code: -1, error }));
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal: signal ?? undefined }));
  });
  activeChildren.delete(child);
  if (child.pid) options.onExit?.(child.pid);
  clearTimeout(timer);
  stream.end();

  if (timedOut) {
    return {
      ok: false,
      error: `agent timed out after ${Math.round(limit / 60000)} min`,
      logPath,
      tail: truncate(tail, 2000),
      tokens: provider.parseUsage?.(tail) ?? parseUsage(tail, profile.executor.usage) ?? undefined,
      providerLimit: null
    };
  }
  if (exit.error) {
    return { ok: false, error: `agent failed to start: ${exit.error.message}`, logPath, tail: truncate(tail, 2000), providerLimit: null };
  }
  let parsed: AgentResult | null = null;
  if (existsSync(resultPath)) {
    try {
      parsed = JSON.parse(await readFile(resultPath, "utf8")) as AgentResult;
    } catch (error) {
      return {
        ok: false,
        error: `result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        logPath,
        tail: truncate(tail, 2000),
        tokens: provider.parseUsage?.(tail) ?? parseUsage(tail, profile.executor.usage) ?? undefined,
        providerLimit: null
      };
    }
  } else if (resultMode === "stdout") {
    parsed = extractJsonResult(tail);
  }

  if (!parsed) {
    return {
      ok: false,
      error: `agent exited (${exit.code}) without writing ${resultPath}`,
      logPath,
      tail: truncate(tail, 3000),
      tokens: provider.parseUsage?.(tail) ?? parseUsage(tail, profile.executor.usage) ?? undefined,
      providerLimit: null
    };
  }

  const tokens = parsed.tokens ?? provider.parseUsage?.(tail) ?? parseUsage(tail, profile.executor.usage) ?? undefined;
  const failed = parsed.ok !== true || parsed.blocked === true;
  return {
    ...parsed,
    ok: parsed.ok === true && parsed.blocked !== true,
    blocked: parsed.blocked === true,
    exitCode: exit.code,
    logPath,
    tail: truncate(tail, 3000),
    tokens,
    providerLimit: providerLimitForResult(parsed, failed)
  };
}

export function checksText(profile: ProfileConfig): string {
  if (!profile.checks.length) return "(no checks configured)";
  return profile.checks
    .map((check) => {
      const command = resolveCommand(profile, check.command);
      return `- ${check.name}: \`${command} ${check.args.join(" ")}\``;
    })
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
  loopContext?: string;
  attempt?: number;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  const { profile, profilePaths, issue, memoryText, worktree, branch, base, logger } = options;
  const { resultPath, logPath } = resultPaths(profilePaths, "worker", issue.number);
  const template = await loadPrompt(profile, "worker");
  const workflowRules = formatWorkflowRules(profile, { branch });
  const prTemplate = await loadPrTemplateText(profile, worktree);
  const resultInstruction =
    (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
      ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
      : `Write valid JSON to \`${resultPath}\`.`;
  const rendered = render(template, {
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
    loopContext: options.loopContext || "(none)",
    attempt: options.attempt ?? 1,
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
    resultInstruction,
    worktree,
    branch,
    resultPath,
    logPath
  });
  const prompt = `${rendered}

## Final PR body

Write the complete Markdown PR body into the \`prBody\` field of the result JSON.
Ignore any earlier wording that says the orchestrator fills the template.
Follow the repository PR template above and fill it for this ticket. Include the
ticket link, what changed, test evidence, screenshots (or N/A), risks and notes.
Do not leave \`{{...}}\` placeholders. The orchestrator will use \`prBody\` as-is.
`;
  return runAgent({ profile, profilePaths, role: "worker", prompt, cwd: worktree, resultPath, logPath, logger, onSpawn: options.onSpawn, onExit: options.onExit });
}

export async function runDiscovery(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  memoryText: string;
  repoDir: string;
  parity: string;
  context?: string;
  focus?: string;
  existingIssues: string;
  existingIdeas?: string;
  maxIdeas: number;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  const { profile, profilePaths, memoryText, repoDir, parity, existingIssues, maxIdeas, logger } = options;
  const { resultPath, logPath } = resultPaths(profilePaths, "discovery", "run");
  const template = await loadPrompt(profile, "discovery");
  const prompt = render(template, {
    projectName: projectName(profile),
    stack: profile.stack || profile.ziki.platform,
    repoUrl: profile.repo.githubRepo,
    repoDir,
    platform: profile.ziki.platform,
    parity,
    context: options.context || parity,
    focus: options.focus || "(none configured)",
    existingIssues,
    existingIdeas: options.existingIdeas || "(none)",
    maxIdeas,
    memory: memoryText,
    checks: checksText(profile),
    resultPath,
    logPath,
    resultInstruction: (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
      ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
      : `Write valid JSON to \`${resultPath}\`.`
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

export async function runReview(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  worktree: string;
  prUrl: string;
  headSha: string;
  prContext?: string;
  issueContext?: string;
  loopContext?: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
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
    workflowRules: formatWorkflowRules(profile),
    protectedFiles: formatProtectedFiles(profile),
    worktree,
    prUrl,
    headSha,
    prContext: options.prContext || "(not loaded)",
    issueContext: options.issueContext || "(none)",
    loopContext: options.loopContext || "(none)",
    resultPath,
    logPath,
    resultInstruction: (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
      ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
      : `Write valid JSON to \`${resultPath}\`.`
  });
  return runAgent({ profile, profilePaths, role: "review", prompt, cwd: worktree, resultPath, logPath, logger, onSpawn: options.onSpawn, onExit: options.onExit });
}

export async function runFollowUp(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  worktree: string;
  branch: string;
  base: string;
  prUrl: string;
  prContext: string;
  attempt: number;
  maxAttempts: number;
  previousError?: string;
  loopContext?: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  const { profile, profilePaths, issue, memoryText, worktree, branch, base, prUrl, prContext, logger } = options;
  const { resultPath, logPath } = resultPaths(profilePaths, "followup", issue.number);
  const template = await loadPrompt(profile, "followup");
  const prompt = render(template, {
    projectName: projectName(profile),
    stack: profile.stack || profile.ziki.platform,
    repoUrl: profile.repo.githubRepo,
    base,
    platform: profile.ziki.platform,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issueUrl(profile, issue),
    issueDescription: issue.description || "",
    memory: memoryText,
    checks: checksText(profile),
    workflowRules: formatWorkflowRules(profile, { branch }),
    protectedFiles: formatProtectedFiles(profile),
    worktree,
    branch,
    prUrl,
    prContext,
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    previousError: options.previousError || "(none)",
    loopContext: options.loopContext || "(none)",
    resultPath,
    logPath,
    resultInstruction: (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
      ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
      : `Write valid JSON to \`${resultPath}\`.`
  });
  return runAgent({
    profile,
    profilePaths,
    role: "followup",
    prompt,
    cwd: worktree,
    resultPath,
    logPath,
    logger,
    onSpawn: options.onSpawn,
    onExit: options.onExit
  });
}

export async function runConfirm(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  repoDir: string;
  loopContext?: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
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
    workflowRules: formatWorkflowRules(profile),
    protectedFiles: formatProtectedFiles(profile),
    loopContext: options.loopContext || "(none)",
    resultPath,
    logPath,
    resultInstruction: (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
      ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
      : `Write valid JSON to \`${resultPath}\`.`
  });
  return runAgent({ profile, profilePaths, role: "confirm", prompt, cwd: repoDir, resultPath, logPath, logger, onSpawn: options.onSpawn, onExit: options.onExit });
}

export async function runTriage(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  idea: Idea;
  memoryText: string;
  repoDir: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
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
    workflowRules: formatWorkflowRules(profile),
    protectedFiles: formatProtectedFiles(profile),
    resultPath,
    logPath,
    resultInstruction: (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
      ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
      : `Write valid JSON to \`${resultPath}\`.`
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

export async function runOwner(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  request: { id: string; body: string };
  memoryText: string;
  repoDir: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
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
    logPath,
    resultInstruction: (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
      ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
      : `Write valid JSON to \`${resultPath}\`.`
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

export async function runPromptTask(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  role: Role;
  label: string | number;
  cwd?: string;
  repoDir?: string;
  vars: Record<string, unknown>;
  timeoutMs?: number;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  const { profile, profilePaths, role, label, logger } = options;
  const cwd = options.cwd ?? options.repoDir ?? process.cwd();
  const { resultPath, logPath } = resultPaths(profilePaths, role, label);
  const template = await loadPrompt(profile, role);
  const prompt = render(template, {
    projectName: projectName(profile),
    stack: profile.stack || profile.ziki.platform,
    repoUrl: profile.repo.githubRepo,
    platform: profile.ziki.platform,
    checks: checksText(profile),
    workflowRules: formatWorkflowRules(profile),
    protectedFiles: formatProtectedFiles(profile),
    ...options.vars,
    resultPath,
    logPath,
    resultInstruction:
      (getProvider(profile.executor.provider, profile).resultMode ?? "file") === "stdout"
        ? "Print the final JSON result to stdout. Do not wrap it in Markdown or add other text."
        : `Write valid JSON to \`${resultPath}\`.`
  });
  return runAgent({
    profile,
    profilePaths,
    role,
    prompt,
    cwd,
    resultPath,
    logPath,
    logger,
    timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
    onSpawn: options.onSpawn,
    onExit: options.onExit
  });
}

export async function runEstimate(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "estimate",
    label: options.issue.number,
    vars: {
      issueNumber: options.issue.number,
      issueTitle: options.issue.title,
      issueUrl: issueUrl(options.profile, options.issue),
      issueSummary: options.issue.summary || "",
      issueDescription: options.issue.description || "",
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runInvestigate(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "investigate",
    label: options.issue.number,
    vars: {
      issueNumber: options.issue.number,
      issueTitle: options.issue.title,
      issueUrl: issueUrl(options.profile, options.issue),
      issueSummary: options.issue.summary || "",
      issueDescription: options.issue.description || "",
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runImportance(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "importance",
    label: options.issue.number,
    vars: {
      issueNumber: options.issue.number,
      issueTitle: options.issue.title,
      issueUrl: issueUrl(options.profile, options.issue),
      issueSummary: options.issue.summary || "",
      issueDescription: options.issue.description || "",
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runStakeVote(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue | null;
  stakes: unknown[];
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "stakeVote",
    label: options.issue?.number ?? "stake",
    vars: {
      issueNumber: options.issue?.number ?? "",
      issueTitle: options.issue?.title ?? "",
      issueUrl: options.issue ? issueUrl(options.profile, options.issue) : "",
      issueSummary: options.issue?.summary || "",
      issueDescription: options.issue?.description || "",
      stakes: JSON.stringify(options.stakes, null, 2),
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runSenseCheck(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "senseCheck",
    label: options.issue.number,
    vars: {
      issueNumber: options.issue.number,
      issueTitle: options.issue.title,
      issueUrl: issueUrl(options.profile, options.issue),
      issueSummary: options.issue.summary || "",
      issueDescription: options.issue.description || "",
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runClose(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue;
  actingAs: "working" | "manager";
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "close",
    label: options.issue.number,
    vars: {
      actingAs: options.actingAs,
      issueNumber: options.issue.number,
      issueTitle: options.issue.title,
      issueUrl: issueUrl(options.profile, options.issue),
      issueSummary: options.issue.summary || "",
      issueDescription: options.issue.description || "",
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runResearch(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  job: unknown;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "research",
    label: "job",
    vars: {
      job: JSON.stringify(options.job, null, 2),
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runJobReview(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  job: unknown;
  submission: unknown;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "jobReview",
    label: "job",
    vars: {
      job: JSON.stringify(options.job, null, 2),
      submission: JSON.stringify(options.submission, null, 2),
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}


export async function runBidVote(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue | null;
  bid: unknown;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "bidVote",
    label: options.issue?.number ?? "bid",
    vars: {
      issueNumber: options.issue?.number ?? "",
      issueTitle: options.issue?.title ?? "",
      issueUrl: options.issue ? issueUrl(options.profile, options.issue) : "",
      issueSummary: options.issue?.summary || "",
      issueDescription: options.issue?.description || "",
      bid: JSON.stringify(options.bid, null, 2),
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}

export async function runCommentVote(options: {
  profile: ProfileConfig;
  profilePaths: ProfilePaths;
  issue: Issue | null;
  comment: unknown;
  memoryText: string;
  repoDir: string;
  loopContext: string;
  logger?: Logger;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): Promise<AgentResult> {
  return runPromptTask({
    ...options,
    role: "commentVote",
    label: options.issue?.number ?? "comment",
    vars: {
      issueNumber: options.issue?.number ?? "",
      issueTitle: options.issue?.title ?? "",
      issueUrl: options.issue ? issueUrl(options.profile, options.issue) : "",
      issueSummary: options.issue?.summary || "",
      issueDescription: options.issue?.description || "",
      comment: JSON.stringify(options.comment, null, 2),
      memory: options.memoryText,
      loopContext: options.loopContext
    }
  });
}
