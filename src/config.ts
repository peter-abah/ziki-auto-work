import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  AgentKey,
  CheckSpec,
  Config,
  ProfileConfig,
  ProfilePaths,
  LimitsConfig,
  LoadedProfile,
  ProviderName,
  PushMode,
  Role,
  RunLimitConfig,
  WorkflowConfig
} from "./types.js";
import { PACKAGE_ROOT, expandHome, profilePaths, paths } from "./platform/paths.js";
import { PROVIDER_IDS } from "./providers/index.js";

export const PROVIDERS: ProviderName[] = PROVIDER_IDS;

export const DEFAULT_LIMITS: LimitsConfig = {
  maxDeliveriesPerDay: null,
  maxReviewsPerDay: null,
  maxDiscoveriesPerDay: null,
  maxAuxPerCycle: null,
  maxActiveClaims: "auto",
  maxAttemptsPerTask: 3,
  maxNetworkRetries: 5,
  networkRetryMinutes: 1,
  maxCyclesBeforeDiscovery: 6,
  maxOpenEscalations: 5,
  maxRuntimeMinutes: 120,
  maxCycles: null,
  stopAt: null,
  maxDeliveriesTotal: null,
  maxConcurrentDeliveries: "auto",
  maxConcurrentFollowUps: "auto",
  maxConcurrentReviews: "auto",
  maxConcurrentAux: "auto",
  maxConcurrentDiscovery: 1,
  maxConcurrentAgents: "auto",
  maxTokensPerRun: null,
  tokenWarnPercent: 80,
  providerRetryMinutes: 15
};

export const DEFAULT_RUN_LIMITS = {
  maxRuntimeMinutes: 120,
  maxCycles: null,
  stopAt: null,
  maxDeliveriesTotal: null
};

export const DEFAULT_PR_TRACKING = {
  enabled: true,
  pollMinutes: 10,
  maxFollowUps: 10,
  fixFailingChecks: true,
  fixReviewComments: true
};

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  maxFiles: 5,
  maxLines: 400,
  branchPrefix: "fix",
  commitTypes: ["fix", "feat", "test", "refactor", "chore", "docs", "perf", "security"],
  requireTests: true,
  autoVoteBids: "agent",
  autoUpvoteComments: "agent"
};

export const DEFAULT_ENV_FILES = [".env", ".env.local"];

export function defaultConfig(): Config {
  return {
    version: 3,
    activeProfile: "",
    defaults: {
      executor: {
        provider: "opencode",
        model: null,
        timeoutMs: 2_700_000,
        permissionMode: "auto"
      },
      limits: { ...DEFAULT_LIMITS },
      workflow: { ...DEFAULT_WORKFLOW },
      pollSeconds: 120,
      memoryRefreshMinutes: 30,
      hitl: { enabled: true, defaultType: "question", notify: "auto", notifyCommand: null },
      platformMatch: {},
      discovery: { enabled: false, maxIdeasPerRun: 3 },
      checks: [],
      prompts: { dir: "prompts/generic" },
      pr: { templateFile: "prompts/generic/pr.md" },
      prTracking: { ...DEFAULT_PR_TRACKING }
    },
    profiles: {},
    doctor: { minFreeGb: 3 }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result as T;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1] as string] = value;
  }
  return out;
}

export async function loadEnv(): Promise<Record<string, string>> {
  const p = paths();
  if (!existsSync(p.envFile)) return {};
  return parseEnvFile(await readFile(p.envFile, "utf8"));
}

export async function saveEnv(values: Record<string, string>): Promise<void> {
  const p = paths();
  await mkdir(p.configDir, { recursive: true });
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  await writeFile(p.envFile, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(p.envFile, 0o600).catch(() => {});
}

export function sampleConfigPath(name: string): string {
  return path.join(PACKAGE_ROOT, "examples", `${name}.json`);
}

export async function loadConfig(): Promise<Config> {
  const p = paths();
  if (!existsSync(p.configFile)) {
    const config = defaultConfig();
    await mkdir(p.configDir, { recursive: true });
    await writeFile(p.configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return config;
  }
  const raw = JSON.parse(await readFile(p.configFile, "utf8")) as Record<string, unknown>;
  const version = Number(raw.version);
  if (version !== 3) {
    throw new Error(
      `Config ${p.configFile} is version ${Number.isFinite(version) ? version : "unknown"}; this release uses version 3 (profiles/activeProfile). ` +
        "Run `auto-work init` to write a new config."
    );
  }
  return raw as unknown as Config;
}

export async function saveConfig(config: Config): Promise<void> {
  const p = paths();
  await mkdir(p.configDir, { recursive: true });
  const tmp = `${p.configFile}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, p.configFile);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function requireString(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} is required`);
}

function validateCheck(check: CheckSpec, index: number, errors: string[]): void {
  requireString(check?.name, `checks[${index}].name`, errors);
  requireString(check?.command, `checks[${index}].command`, errors);
  if (!Array.isArray(check?.args)) errors.push(`checks[${index}].args must be an array`);
}

function githubOwner(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim().replace(/\.git$/, "");
  const match = text.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  if (match) return match[1]!.toLowerCase();
  const plain = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return plain ? plain[1]!.toLowerCase() : null;
}

export function inferPushMode(forkOwner: string, upstreamOwner: string, user?: string | null): PushMode {
  const fork = forkOwner.trim().toLowerCase();
  const upstream = upstreamOwner.trim().toLowerCase();
  if (fork && fork === upstream) return "upstream";
  if (user && fork && fork === user.trim().toLowerCase()) return "personal-fork";
  return "team-fork";
}

export function validateConfig(config: Config): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (Number(config.version) !== 3) errors.push("version must be 3");
  if (!config.profiles || typeof config.profiles !== "object" || !Object.keys(config.profiles).length) {
    errors.push("at least one profile is required");
  }
  if (!config.activeProfile) {
    errors.push("activeProfile is required");
  } else if (config.profiles && !config.profiles[config.activeProfile]) {
    errors.push(`activeProfile "${config.activeProfile}" does not exist in profiles`);
  }

  for (const [name, raw] of Object.entries(config.providers ?? {})) {
    const prefix = `providers.${name}`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    requireString(raw.command, `${prefix}.command`, errors);
    if (!Array.isArray(raw.args)) errors.push(`${prefix}.args must be an array`);
    if (raw.resultMode !== undefined && !["file", "stdout"].includes(raw.resultMode)) {
      errors.push(`${prefix}.resultMode must be "file" or "stdout"`);
    }
  }

  for (const [name, rawProfile] of Object.entries(config.profiles ?? {})) {
    const prefix = `profiles.${name}`;
    const profile = deepMerge(config.defaults ?? {}, rawProfile) as ProfileConfig;
    requireString(profile?.ziki?.baseUrl, `${prefix}.ziki.baseUrl`, errors);
    requireString(profile?.ziki?.projectId, `${prefix}.ziki.projectId`, errors);
    requireString(profile?.ziki?.projectSlug, `${prefix}.ziki.projectSlug`, errors);
    requireString(profile?.ziki?.platform, `${prefix}.ziki.platform`, errors);
    requireString(profile?.repo?.url, `${prefix}.repo.url`, errors);
    requireString(profile?.repo?.upstream, `${prefix}.repo.upstream`, errors);
    requireString(profile?.repo?.base, `${prefix}.repo.base`, errors);
    requireString(profile?.repo?.githubRepo, `${prefix}.repo.githubRepo`, errors);
    requireString(profile?.repo?.forkOwner, `${prefix}.repo.forkOwner`, errors);
    requireString(profile?.repo?.defaultBranch, `${prefix}.repo.defaultBranch`, errors);
    if (profile?.repo?.pushMode !== undefined && !["personal-fork", "team-fork", "upstream"].includes(profile.repo.pushMode)) {
      errors.push(`${prefix}.repo.pushMode must be "personal-fork", "team-fork" or "upstream"`);
    } else if (profile?.repo?.forkOwner && profile?.repo?.githubRepo) {
      const upstreamOwner = githubOwner(profile.repo.githubRepo);
      const forkOwner = profile.repo.forkOwner.trim().toLowerCase();
      const urlOwner = githubOwner(profile.repo.url);
      if (upstreamOwner && forkOwner === upstreamOwner && !profile.repo.pushMode) {
        warnings.push(`${prefix}.repo.forkOwner is the upstream owner; set repo.pushMode to "upstream" explicitly`);
      }
      if (profile.repo.pushMode === "upstream" && upstreamOwner && forkOwner !== upstreamOwner) {
        errors.push(`${prefix}.repo.forkOwner must equal the upstream owner when pushMode is "upstream"`);
      }
      if (profile.repo.pushMode && profile.repo.pushMode !== "upstream" && upstreamOwner && forkOwner === upstreamOwner) {
        errors.push(`${prefix}.repo.forkOwner equals the upstream owner; use pushMode "upstream"`);
      }
      if (urlOwner && forkOwner && profile.repo.pushMode !== "upstream" && urlOwner !== forkOwner) {
        errors.push(`${prefix}.repo.url owner "${urlOwner}" does not match repo.forkOwner "${forkOwner}"`);
      }
      if (urlOwner && upstreamOwner && profile.repo.pushMode === "upstream" && urlOwner !== upstreamOwner) {
        errors.push(`${prefix}.repo.url owner "${urlOwner}" does not match the upstream owner "${upstreamOwner}"`);
      }
    }
    if (!profile?.repo?.teamLead) warnings.push(`${prefix}.repo.teamLead is empty; the PR template may need it`);
    const workers = profile?.agents?.workers;
    const managers = profile?.agents?.managers;
    if (!Array.isArray(workers)) errors.push(`${prefix}.agents.workers must be an array`);
    if (!Array.isArray(managers)) errors.push(`${prefix}.agents.managers must be an array`);
    if (Array.isArray(workers) && Array.isArray(managers) && !workers.length && !managers.length) {
      errors.push(`${prefix}.agents needs at least one worker or manager env key name`);
    }
    if (Array.isArray(managers) && managers.length === 0) {
      warnings.push(`${prefix}.agents.managers is empty; manager-only actions (merge review, accept, cross-platform moves) will be skipped`);
    }
    if (Array.isArray(workers) && workers.length === 0 && Array.isArray(managers) && managers.length > 0) {
      warnings.push(`${prefix}.agents.workers is empty; manager keys will also do working tasks`);
    }
    const providerIds = new Set([
      ...PROVIDERS,
      ...Object.keys(config.providers ?? {}),
      ...Object.keys(profile?.providers ?? {})
    ]);
    if (!providerIds.has(profile?.executor?.provider)) {
      errors.push(`${prefix}.executor.provider must be one of ${[...providerIds].join(", ")}`);
    }
    if (profile?.executor?.provider === "custom") {
      requireString(profile?.executor?.command, `${prefix}.executor.command`, errors);
    }
    if (!Array.isArray(profile?.checks)) {
      errors.push(`${prefix}.checks must be an array`);
    } else {
      profile.checks.forEach((check, index) => validateCheck(check, index, errors));
    }
    requireString(profile?.prompts?.dir, `${prefix}.prompts.dir`, errors);
    requireString(profile?.pr?.templateFile, `${prefix}.pr.templateFile`, errors);
    if (profile?.prTracking !== undefined) {
      const tracking = profile.prTracking;
      if (typeof tracking.enabled !== "boolean") errors.push(`${prefix}.prTracking.enabled must be a boolean`);
      if (!Number.isFinite(tracking.pollMinutes) || tracking.pollMinutes < 1) {
        errors.push(`${prefix}.prTracking.pollMinutes must be at least 1`);
      }
      if (!Number.isInteger(tracking.maxFollowUps) || tracking.maxFollowUps < 0) {
        errors.push(`${prefix}.prTracking.maxFollowUps must be a non-negative integer`);
      }
    }
    if (!profile?.limits || typeof profile.limits !== "object") {
      errors.push(`${prefix}.limits is required`);
    } else {
      const capacityKeys = [
        "maxDeliveriesPerDay",
        "maxReviewsPerDay",
        "maxDiscoveriesPerDay",
        "maxAuxPerCycle",
        "maxActiveClaims",
        "maxConcurrentDeliveries",
        "maxConcurrentFollowUps",
        "maxConcurrentReviews",
        "maxConcurrentAux",
        "maxConcurrentDiscovery",
        "maxConcurrentAgents"
      ] as const;
      for (const key of capacityKeys) {
        const value = (profile.limits as unknown as Record<string, unknown>)[key];
        if (value === undefined || value === null || value === "auto") continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          errors.push(`${prefix}.limits.${key} must be a non-negative number, "auto" or null`);
        }
      }
    }
    if (profile?.repo?.mergeMode !== undefined && !["handoff", "never", "auto"].includes(profile.repo.mergeMode)) {
      errors.push(`${prefix}.repo.mergeMode must be "handoff", "never" or "auto"`);
    }
    if (profile?.repo?.mergeMethod !== undefined && !["merge", "squash", "rebase"].includes(profile.repo.mergeMethod)) {
      errors.push(`${prefix}.repo.mergeMethod must be "merge", "squash" or "rebase"`);
    }
    if (profile?.discovery?.contextFiles !== undefined && !Array.isArray(profile.discovery.contextFiles)) {
      errors.push(`${prefix}.discovery.contextFiles must be an array`);
    }
    if (profile?.discovery?.focus !== undefined && typeof profile.discovery.focus !== "string") {
      errors.push(`${prefix}.discovery.focus must be a string`);
    }
    if (profile?.agentProfile?.skills !== undefined) {
      if (!Array.isArray(profile.agentProfile.skills)) {
        errors.push(`${prefix}.agentProfile.skills must be an array`);
      } else {
        profile.agentProfile.skills.forEach((skill, index) => {
          requireString(skill?.tag, `${prefix}.agentProfile.skills[${index}].tag`, errors);
          requireString(skill?.summary, `${prefix}.agentProfile.skills[${index}].summary`, errors);
          requireString(skill?.description, `${prefix}.agentProfile.skills[${index}].description`, errors);
        });
      }
    }
    const workflow = profile?.workflow;
    if (!workflow || typeof workflow !== "object") {
      warnings.push(`${prefix}.workflow is missing; defaults will be used`);
    } else {
      if (!Number.isInteger(workflow.maxFiles) || workflow.maxFiles < 1) {
        errors.push(`${prefix}.workflow.maxFiles must be a positive integer`);
      }
      if (!Number.isInteger(workflow.maxLines) || workflow.maxLines < 1) {
        errors.push(`${prefix}.workflow.maxLines must be a positive integer`);
      }
      if (typeof workflow.branchPrefix !== "string" || !workflow.branchPrefix.trim()) {
        errors.push(`${prefix}.workflow.branchPrefix is required`);
      }
      if (!Array.isArray(workflow.commitTypes) || !workflow.commitTypes.length) {
        errors.push(`${prefix}.workflow.commitTypes must be a non-empty array`);
      }
      for (const key of ["autoVoteBids", "autoUpvoteComments"] as const) {
        const value = workflow[key];
        if (value !== undefined && !["off", "agent", "heuristic"].includes(value)) {
          errors.push(`${prefix}.workflow.${key} must be "off", "agent" or "heuristic"`);
        }
      }
    }
    if (profile?.repo?.envFiles !== undefined && !Array.isArray(profile.repo.envFiles)) {
      errors.push(`${prefix}.repo.envFiles must be an array`);
    }
    if (profile?.repo?.requiredEnv !== undefined && !Array.isArray(profile.repo.requiredEnv)) {
      errors.push(`${prefix}.repo.requiredEnv must be an array`);
    }
    if (typeof profile?.pollSeconds !== "number" || profile.pollSeconds < 10) {
      errors.push(`${prefix}.pollSeconds must be at least 10`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function resolveRunLimits(profile: ProfileConfig, override?: Partial<RunLimitConfig> | null): RunLimitConfig {
  const base: RunLimitConfig = {
    maxRuntimeMinutes: profile.limits.maxRuntimeMinutes ?? null,
    maxCycles: profile.limits.maxCycles ?? null,
    stopAt: profile.limits.stopAt ?? null,
    maxDeliveriesTotal: profile.limits.maxDeliveriesTotal ?? null
  };
  if (!override) return base;
  return {
    maxRuntimeMinutes: override.maxRuntimeMinutes !== undefined ? override.maxRuntimeMinutes : base.maxRuntimeMinutes,
    maxCycles: override.maxCycles !== undefined ? override.maxCycles : base.maxCycles,
    stopAt: override.stopAt !== undefined ? override.stopAt : base.stopAt,
    maxDeliveriesTotal: override.maxDeliveriesTotal !== undefined ? override.maxDeliveriesTotal : base.maxDeliveriesTotal
  };
}

export function resolveModel(profile: ProfileConfig, role: Role): string | null {
  const models = profile.executor.models ?? {};
  if (role === "followup") return models.followup ?? models.worker ?? profile.executor.model ?? null;
  return models[role] ?? profile.executor.model ?? null;
}

export function resolveMergeMode(profile: ProfileConfig): "handoff" | "never" | "auto" {
  return profile.repo.mergeMode ?? "handoff";
}

export function resolveMergeMethod(profile: ProfileConfig): "merge" | "squash" | "rebase" {
  return profile.repo.mergeMethod ?? "squash";
}

export function resolvePromptDir(profile: ProfileConfig): string {
  const dir = profile.prompts.dir;
  return path.isAbsolute(dir) ? dir : path.join(PACKAGE_ROOT, dir);
}

export function resolvePrTemplate(profile: ProfileConfig): string {
  const file = profile.pr.templateFile;
  return path.isAbsolute(file) ? file : path.join(PACKAGE_ROOT, file);
}

export function resolveParityFile(profile: ProfileConfig): string | null {
  const file = profile.discovery.parityFile;
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(PACKAGE_ROOT, file);
}

export async function ensureProfileDirs(profilePathsValue: ProfilePaths): Promise<void> {
  await Promise.all([
    mkdir(profilePathsValue.stateDir, { recursive: true }),
    mkdir(profilePathsValue.logsDir, { recursive: true }),
    mkdir(profilePathsValue.worktreesDir, { recursive: true }),
    mkdir(profilePathsValue.reposDir, { recursive: true }),
    mkdir(profilePathsValue.resultsDir, { recursive: true })
  ]);
}

export async function loadProfile(profileName?: string): Promise<LoadedProfile> {
  const config = await loadConfig();
  const name = profileName || config.activeProfile;
  const rawProfile = config.profiles?.[name];
  if (!rawProfile) {
    throw new Error(
      `Unknown profile "${name || "(none)"}". Available: ${Object.keys(config.profiles ?? {}).join(", ") || "none"}. Run \`auto-work init\`.`
    );
  }
  const profile = deepMerge(config.defaults ?? {}, rawProfile) as ProfileConfig;
  profile.limits = { ...DEFAULT_LIMITS, ...(profile.limits ?? {}) };
  profile.workflow = { ...DEFAULT_WORKFLOW, ...(profile.workflow ?? {}) };
  profile.providers = { ...(config.providers ?? {}), ...(profile.providers ?? {}) };
  profile.repo = { ...profile.repo, envFiles: profile.repo?.envFiles ?? DEFAULT_ENV_FILES };
  profile.executor = { ...profile.executor, timeoutMs: profile.executor?.timeoutMs ?? 2_700_000, permissionMode: profile.executor?.permissionMode ?? "auto" };
  const validation = validateConfig({ ...config, activeProfile: name, profiles: { [name]: profile } });
  if (!validation.ok) {
    throw new Error(`Invalid profile "${name}":\n${validation.errors.join("\n")}`);
  }

  const env = await loadEnv();
  const getKey = (keyName: string): string | null => env[keyName] || process.env[keyName] || null;
  const toKeys = (names: string[]): AgentKey[] =>
    names
      .map((keyName) => ({ name: keyName, key: getKey(keyName) }))
      .filter((entry): entry is AgentKey => Boolean(entry.key));

  const keys = {
    workers: toKeys(profile.agents.workers),
    managers: toKeys(profile.agents.managers)
  };
  if (!keys.workers.length && !keys.managers.length) {
    throw new Error(`No valid agent keys for profile "${name}". Add them to ${paths().envFile}.`);
  }

  const profilePathsValue = profilePaths(name);
  await ensureProfileDirs(profilePathsValue);

  return {
    config,
    profileName: name,
    profile,
    paths: paths(),
    profilePaths: profilePathsValue,
    env,
    keys,
    getKey
  };
}

export { expandHome };
