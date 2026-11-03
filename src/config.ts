import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  AgentKey,
  CheckSpec,
  Config,
  JobConfig,
  JobPaths,
  LimitsConfig,
  LoadedJob,
  ProviderName,
  Role
} from "./types.js";
import { PACKAGE_ROOT, expandHome, jobPaths, paths } from "./platform/paths.js";

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
    version: 2,
    activeJob: "",
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
    jobs: {}
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
  if (Number(raw.version) === 1) {
    const migrated = migrateConfig(raw);
    await mkdir(p.configDir, { recursive: true });
    await copyFile(p.configFile, `${p.configFile}.v1.bak`).catch(() => {});
    await saveConfig(migrated);
    return migrated;
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

  if (Number(config.version) !== 2) errors.push("version must be 2");
  if (!config.jobs || typeof config.jobs !== "object" || !Object.keys(config.jobs).length) {
    errors.push("at least one job is required");
  }
  if (!config.activeJob) {
    errors.push("activeJob is required");
  } else if (config.jobs && !config.jobs[config.activeJob]) {
    errors.push(`activeJob "${config.activeJob}" does not exist in jobs`);
  }

  for (const [name, rawJob] of Object.entries(config.jobs ?? {})) {
    const prefix = `jobs.${name}`;
    const job = deepMerge(config.defaults ?? {}, rawJob) as JobConfig;
    requireString(job?.ziki?.baseUrl, `${prefix}.ziki.baseUrl`, errors);
    requireString(job?.ziki?.projectId, `${prefix}.ziki.projectId`, errors);
    requireString(job?.ziki?.projectSlug, `${prefix}.ziki.projectSlug`, errors);
    requireString(job?.ziki?.platform, `${prefix}.ziki.platform`, errors);
    requireString(job?.repo?.url, `${prefix}.repo.url`, errors);
    requireString(job?.repo?.upstream, `${prefix}.repo.upstream`, errors);
    requireString(job?.repo?.base, `${prefix}.repo.base`, errors);
    requireString(job?.repo?.githubRepo, `${prefix}.repo.githubRepo`, errors);
    requireString(job?.repo?.forkOwner, `${prefix}.repo.forkOwner`, errors);
    requireString(job?.repo?.defaultBranch, `${prefix}.repo.defaultBranch`, errors);
    if (!job?.repo?.teamLead) warnings.push(`${prefix}.repo.teamLead is empty; the PR template may need it`);
    if (!Array.isArray(job?.agents?.workers) || !job.agents.workers.length) {
      errors.push(`${prefix}.agents.workers must contain at least one env key name`);
    }
    if (!Array.isArray(job?.agents?.managers) || !job.agents.managers.length) {
      errors.push(`${prefix}.agents.managers must contain at least one env key name`);
    }
    if (!PROVIDERS.includes(job?.executor?.provider)) {
      errors.push(`${prefix}.executor.provider must be one of ${PROVIDERS.join(", ")}`);
    }
    if (job?.executor?.provider === "custom") {
      requireString(job?.executor?.command, `${prefix}.executor.command`, errors);
    }
    if (!Array.isArray(job?.checks)) {
      errors.push(`${prefix}.checks must be an array`);
    } else {
      job.checks.forEach((check, index) => validateCheck(check, index, errors));
    }
    requireString(job?.prompts?.dir, `${prefix}.prompts.dir`, errors);
    requireString(job?.pr?.templateFile, `${prefix}.pr.templateFile`, errors);
    if (!job?.limits || typeof job.limits !== "object") {
      errors.push(`${prefix}.limits is required`);
    }
    if (typeof job?.pollSeconds !== "number" || job.pollSeconds < 10) {
      errors.push(`${prefix}.pollSeconds must be at least 10`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function resolveModel(job: JobConfig, role: Role): string | null {
  const models = job.executor.models ?? {};
  return models[role] ?? job.executor.model ?? null;
}

export function resolvePromptDir(job: JobConfig): string {
  const dir = job.prompts.dir;
  return path.isAbsolute(dir) ? dir : path.join(PACKAGE_ROOT, dir);
}

export function resolvePrTemplate(job: JobConfig): string {
  const file = job.pr.templateFile;
  return path.isAbsolute(file) ? file : path.join(PACKAGE_ROOT, file);
}

export function resolveParityFile(job: JobConfig): string | null {
  const file = job.discovery.parityFile;
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(PACKAGE_ROOT, file);
}

export async function ensureJobDirs(jobPathsValue: JobPaths): Promise<void> {
  await Promise.all([
    mkdir(jobPathsValue.stateDir, { recursive: true }),
    mkdir(jobPathsValue.logsDir, { recursive: true }),
    mkdir(jobPathsValue.worktreesDir, { recursive: true }),
    mkdir(jobPathsValue.reposDir, { recursive: true }),
    mkdir(jobPathsValue.resultsDir, { recursive: true })
  ]);
}

export async function loadJob(jobName?: string): Promise<LoadedJob> {
  const config = await loadConfig();
  const name = jobName || config.activeJob;
  const rawJob = config.jobs?.[name];
  if (!rawJob) {
    throw new Error(
      `Unknown job "${name || "(none)"}". Available: ${Object.keys(config.jobs ?? {}).join(", ") || "none"}. Run \`auto-work init\`.`
    );
  }
  const job = deepMerge(config.defaults ?? {}, rawJob) as JobConfig;
  const validation = validateConfig({ ...config, activeJob: name, jobs: { [name]: job } });
  if (!validation.ok) {
    throw new Error(`Invalid job "${name}":\n${validation.errors.join("\n")}`);
  }

  const env = await loadEnv();
  const getKey = (keyName: string): string | null => env[keyName] || process.env[keyName] || null;
  const toKeys = (names: string[]): AgentKey[] =>
    names
      .map((keyName) => ({ name: keyName, key: getKey(keyName) }))
      .filter((entry): entry is AgentKey => Boolean(entry.key));

  const keys = {
    workers: toKeys(job.agents.workers),
    managers: toKeys(job.agents.managers)
  };
  if (!keys.workers.length && !keys.managers.length) {
    throw new Error(`No valid agent keys for job "${name}". Add them to ${paths().envFile}.`);
  }

  const jobPathsValue = jobPaths(name);
  await ensureJobDirs(jobPathsValue);

  return {
    config,
    jobName: name,
    job,
    paths: paths(),
    jobPaths: jobPathsValue,
    env,
    keys,
    getKey
  };
}

export function migrateConfig(raw: Record<string, unknown>): Config {
  const oldJobs = (raw.jobs ?? {}) as Record<string, Record<string, unknown>>;
  const jobs: Record<string, JobConfig> = {};

  for (const [name, old] of Object.entries(oldJobs)) {
    const repo = (old.repo ?? {}) as Record<string, unknown>;
    const isDesktop = String(repo.githubRepo ?? "").includes("zedu-desktop");
    const checks: CheckSpec[] = isDesktop
      ? [
          { name: "deps", command: "flutter", args: ["pub", "get"], timeoutMs: 600_000 },
          {
            name: "format",
            command: "dart",
            args: ["format", "--output=none", "--set-exit-if-changed"],
            filesOnly: true,
            include: [".dart"]
          },
          { name: "analyze", command: "flutter", args: ["analyze", "--fatal-infos", "--fatal-warnings"] },
          {
            name: "test",
            command: "flutter",
            args: ["test", "--reporter", "json"],
            reporter: "json",
            baseline: true,
            timeoutMs: 1_800_000
          }
        ]
      : [];

    jobs[name] = {
      ziki: {
        baseUrl: "https://ziki.dev",
        projectId: String(old.projectId ?? ""),
        projectSlug: String(old.projectSlug ?? ""),
        platform: String(old.platform ?? ""),
        ...(old.platformCategoryId ? { platformCategoryId: String(old.platformCategoryId) } : {}),
        ...(isDesktop ? { projectName: "Zedu Desktop" } : {})
      },
      ...(isDesktop ? { stack: "Flutter 3.41.5 (Windows/macOS/Linux)" } : {}),
      repo: {
        url: String(repo.url ?? ""),
        upstream: String(repo.upstream ?? ""),
        base: String(repo.base ?? "main"),
        githubRepo: String(repo.githubRepo ?? ""),
        forkOwner: String(repo.forkOwner ?? ""),
        defaultBranch: String(repo.defaultBranch ?? "main"),
        ...(repo.teamLead ? { teamLead: String(repo.teamLead) } : {}),
        ...(isDesktop ? { baselineFile: "lib/main.dart" } : {})
      },
      agents: (old.agents ?? { workers: [], managers: [] }) as JobConfig["agents"],
      executor: {
        provider: "opencode",
        model: null,
        timeoutMs: 2_700_000,
        permissionMode: "auto"
      },
      toolchain: (old.toolchain ?? {}) as Record<string, string>,
      checks,
      platformMatch: isDesktop ? { keywords: ["desktop", "flutter", "linux", "windows", "macos"] } : {},
      prompts: { dir: isDesktop ? "prompts/zedu-desktop" : "prompts/generic" },
      pr: {
        templateFile: isDesktop ? "prompts/zedu-desktop/pr.md" : "prompts/generic/pr.md",
        ...(repo.teamLead ? { teamLead: String(repo.teamLead) } : {})
      },
      discovery: (old.discovery ?? { enabled: false, maxIdeasPerRun: 3 }) as JobConfig["discovery"],
      limits: (old.limits ?? { ...DEFAULT_LIMITS }) as LimitsConfig,
      pollSeconds: Number(old.pollSeconds ?? 120),
      memoryRefreshMinutes: Number(old.memoryRefreshMinutes ?? 30),
      hitl: (old.hitl ?? { enabled: true, defaultType: "question", notifyCommand: null }) as JobConfig["hitl"]
    };
  }

  return {
    version: 2,
    activeJob: String(raw.activeJob ?? Object.keys(jobs)[0] ?? ""),
    defaults: (raw.defaults ?? {}) as Partial<JobConfig>,
    jobs
  };
}

export { expandHome };
