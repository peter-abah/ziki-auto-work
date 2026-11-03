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
  Role
} from "./types.js";
import { PACKAGE_ROOT, expandHome, profilePaths, paths } from "./platform/paths.js";

export const PROVIDERS: ProviderName[] = ["opencode", "claude", "codex", "gemini", "custom"];

export const DEFAULT_LIMITS: LimitsConfig = {
  maxDeliveriesPerDay: 10,
  maxReviewsPerDay: 20,
  maxDiscoveriesPerDay: 5,
  maxAuxPerCycle: 4,
  maxActiveClaims: 2,
  maxAttemptsPerTask: 3,
  maxCyclesBeforeDiscovery: 6,
  maxOpenEscalations: 5
};

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
      pollSeconds: 120,
      memoryRefreshMinutes: 30,
      hitl: { enabled: true, defaultType: "question", notifyCommand: null },
      platformMatch: {},
      discovery: { enabled: false, maxIdeasPerRun: 3 },
      checks: [],
      prompts: { dir: "prompts/generic" },
      pr: { templateFile: "prompts/generic/pr.md" }
    },
    profiles: {}
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
    if (!profile?.repo?.teamLead) warnings.push(`${prefix}.repo.teamLead is empty; the PR template may need it`);
    const workers = profile?.agents?.workers;
    const managers = profile?.agents?.managers;
    if (!Array.isArray(workers)) errors.push(`${prefix}.agents.workers must be an array`);
    if (!Array.isArray(managers)) errors.push(`${prefix}.agents.managers must be an array`);
    if (Array.isArray(workers) && Array.isArray(managers) && !workers.length && !managers.length) {
      errors.push(`${prefix}.agents needs at least one worker or manager env key name`);
    }
    if (!PROVIDERS.includes(profile?.executor?.provider)) {
      errors.push(`${prefix}.executor.provider must be one of ${PROVIDERS.join(", ")}`);
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
    if (!profile?.limits || typeof profile.limits !== "object") {
      errors.push(`${prefix}.limits is required`);
    }
    if (typeof profile?.pollSeconds !== "number" || profile.pollSeconds < 10) {
      errors.push(`${prefix}.pollSeconds must be at least 10`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function resolveModel(profile: ProfileConfig, role: Role): string | null {
  const models = profile.executor.models ?? {};
  return models[role] ?? profile.executor.model ?? null;
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
