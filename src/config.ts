import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  AgentKey,
  CheckSpec,
  Config,
  ConfigPatchOp,
  ProfileConfig,
  ProfilePaths,
  LimitsConfig,
  LoadedProfile,
  ProviderName,
  PushMode,
  RepairConfig,
  RepairStrategyConfig,
  Role,
  RunLimitConfig,
  WorkflowConfig,
  ZikiConfig
} from "./types.js";
import { PACKAGE_ROOT, expandHome, profilePaths, paths } from "./platform/paths.js";
import { PROVIDER_IDS } from "./providers/index.js";
import {
  BUILTIN_IDENTITY_VARS,
  validateEndpointVars,
  validateEndpoints
} from "./ziki-endpoints.js";
import { loadInitTemplatesSync } from "./config-templates.js";

function templateEndpoints(): Record<string, Record<string, string>> {
  const templates = loadInitTemplatesSync() as unknown as Record<string, unknown>;
  return (templates.endpoints ?? {}) as Record<string, Record<string, string>>;
}

export const PROVIDERS: ProviderName[] = PROVIDER_IDS;

export const DEFAULT_LIMITS: LimitsConfig = {
  maxActiveClaims: "auto",
  maxAttemptsPerTask: null,
  maxNetworkRetries: 5,
  networkRetryMinutes: 1,
  maxCyclesBeforeDiscovery: 6,
  maxOpenEscalations: null,
  maxRuntimeMinutes: null,
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
  maxRuntimeMinutes: null,
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

/**
 * Agent-driven config repair (approval-gated) defaults.
 *
 * The agent may only PROPOSE patches; the orchestrator validates every op
 * against the allowlist below, and nothing persists without human approval.
 * Paths the agent must never touch — even if explicitly allowlisted — are
 * refused in `validateConfig` (fail closed): repo/executor/providers/agents
 * (push targets, command execution, key bindings), hitl/repair itself (the
 * agent must not loosen its own gating), prompts, secrets, and config roots.
 */
export const DEFAULT_REPAIR_MUTABLE_PATHS = [
  "ziki.projectId",
  "ziki.projectSlug",
  "ziki.orgSlug",
  "ziki.platform",
  "ziki.platformCategoryId",
  "ziki.platformFilter",
  "ziki.vars.*",
  "ziki.endpoints.*",
  "operations.*",
  "transport.*",
  "queue.*",
  "reviewGate.*",
  "heartbeatPolicy.*",
  "decisions.*",
  "noop.patterns",
  "votes.*",
  "idea.*",
  "apiRepair.*",
  "capacity.*",
  "urls.*",
  "discover.*",
  "github.*",
  "safety.*",
  "checksDefaults.*",
  "outbox.*",
  "loop.*",
  "offline.*",
  "discovery.*",
  // Observation cadences only: safe for agents to tune (bounded below).
  // Action-affecting timing (heartbeats, timeouts, review windows) stays
  // human-only: wrong values here lose claims or burn budget silently.
  // Exception: heartbeatMs is NEVER agent-mutable (claim pacing).
  "timing.markRecentMs",
  "timing.offlineWatchMs",
  "timing.offlineFreshMs",
  "timing.repoHealthMs",
  "timing.agentDefaultMs",
  "timing.triageMs",
  "timing.ownerMs",
  "timing.discoveryMs",
  "timing.repairMs",
  "timing.doctorMs",
  "timing.heartbeatDefaultMs",
  "timing.reviewTransientMs",
  "timing.reviewTerminalMs",
  "timing.rateLimitChunkMs",
  "limits.*",
  "workflow.*",
  "prTracking.*",
  "discovery.*",
  "pollSeconds",
  "memoryRefreshMinutes",
  "pollSeconds",
  "memoryRefreshMinutes",
  "discovery.enabled",
  "discovery.maxIdeasPerRun",
  // statuses.* is deliberately absent: redefining what counts as done can
  // silently skip paid work. Only statuses.known (drift vocabulary) is
  // agent-proposable, via deterministic diagnosis, never redefinition.
  "statuses.known",
  "health.retryMs.*"
];

export const DEFAULT_REPAIR_ALLOW_NEW_KEYS = [
  "ziki.platformFilter",
  "ziki.orgSlug",
  // New Ziki work kinds arrive as new priority keys; values must be numbers
  // (enforced in validateConfigPatch).
  "queue.priorities.*",
  // New endpoint/operation names are proposable ONLY behind the human
  // APPROVE gate, with Ziki's live llms.txt in the doctor's evidence and
  // live verification before escalation. The agent acting alone still
  // cannot invent routes: unapproved proposals never persist.
  "ziki.endpoints.*",
  "operations.*"
];

export const DEFAULT_ZIKI_STATUSES = {
  workable: ["requires_confirmation", "open", "in_progress"],
  terminal: ["resolved", "closed", "done", "merge", "accepted"],
  terminalSubstatus: ["done", "merge"],
  confirmation: ["requires_confirmation"],
  known: [
    // statuses
    "open", "requires_confirmation", "in_progress", "resolved", "closed",
    "done", "merge", "accepted", "archived", "converted", "rejected",
    // substatuses
    "on_dev", "on_staging", "on_prod",
    // feed kinds the loop knows how to handle
    "ready_issue", "test_fix", "award_bid", "review_bid", "review_comment",
    "reclaim_issue", "investigate_issue", "report_deployment", "report_pr_status",
    "categorize", "sense_check", "active_claim", "offer", "review_offer",
    "job_review_offer", "open_issue", "confirm_issue", "vote_importance",
    "estimate_reward", "refresh_stake", "vote_stake", "merge_review",
    "close_issue", "research_job", "review_idle", "join_request", "idea"
  ]
};

export const DEFAULT_TIMING = {
  agentDefaultMs: 45 * 60_000,
  triageMs: 20 * 60_000,
  ownerMs: 30 * 60_000,
  discoveryMs: 45 * 60_000,
  repairMs: 5 * 60_000,
  doctorMs: 5 * 60_000,
  markRecentMs: 30 * 60_000,
  offlineWatchMs: 15 * 60_000,
  offlineFreshMs: 30 * 60_000,
  repoHealthMs: 6 * 60 * 60_000,
  heartbeatMs: null as number | null,
  heartbeatDefaultMs: 10 * 60_000,
  reviewTransientMs: 5 * 60_000,
  reviewTerminalMs: 30 * 60_000,
  rateLimitChunkMs: 5 * 60_000
};

export const DEFAULT_REPAIR_STRATEGIES: Record<string, RepairStrategyConfig> = {
  "platform:not_found": { enabled: true, role: "configDoctor", maxRounds: 3 },
  "feed:not_found": { enabled: true, role: "configDoctor", maxRounds: 3 },
  "feed:unexpected_response_shape": { enabled: true, role: "configDoctor", maxRounds: 3 },
  "*:not_found": { enabled: true, role: "configDoctor", maxRounds: 2 },
  "*:unknown_filter": { enabled: true, role: "configDoctor", maxRounds: 2 },
  "config:missing_key": { enabled: true, role: "configDoctor", maxRounds: 2 },
  "config:unknown_endpoint": { enabled: true, role: "configDoctor", maxRounds: 2 },
  "*:unknown_kind": { enabled: true, role: "configDoctor", maxRounds: 2 },
  "*:unknown_vocabulary": { enabled: true, role: "configDoctor", maxRounds: 2 }
};

const NEVER_MUTABLE_PATTERNS = [
  /^repo\./,
  /^executor\./,
  /^providers\./,
  /^agents\./,
  /^prompts\./,
  /^pr\./,
  /^hitl\./,
  /^repair\./,
  /^doctor\./,
  /^(version|activeProfile|defaults|profiles|doctor)\b/,
  /secret|token|apikey|api_key|password|private/i
];

export function isNeverMutablePath(path: string): boolean {
  return NEVER_MUTABLE_PATTERNS.some((pattern) => pattern.test(path));
}

function pathMatchesAllowlist(path: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => {
    if (entry.endsWith(".*")) return path === entry.slice(0, -2) || path.startsWith(`${entry.slice(0, -2)}.`);
    return path === entry;
  });
}

/**
 * allowNewKeys supports trailing-wildcard entries (`queue.priorities.*`):
 * exact match wins, otherwise a `prefix.*` entry covers `prefix.<anything>`.
 */
function allowNewKey(opPath: string, allowNewKeys: readonly string[]): boolean {
  if (allowNewKeys.includes(opPath)) return true;
  return allowNewKeys.some(
    (entry) => entry.endsWith(".*") && opPath.startsWith(`${entry.slice(0, -2)}.`)
  );
}

/** Read a dot-path (`ziki.projectId`) from a profile object. */
export function getConfigPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Return a deep clone of `obj` with the dot-path set to `value`. */
export function setConfigPath<T>(obj: T, path: string, value: unknown): T {
  const clone = JSON.parse(JSON.stringify(obj ?? {})) as Record<string, unknown>;
  const parts = path.split(".");
  let current = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const next = current[part];
    const holder = isPlainObject(next) ? (next as Record<string, unknown>) : {};
    current[part] = holder;
    current = holder;
  }
  current[parts[parts.length - 1]!] = value as unknown;
  return clone as T;
}

export interface PatchValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate an agent-proposed patch WITHOUT applying it. Fails closed:
 * unknown paths, denylisted paths, new keys outside allowNewKeys, and
 * type changes are all rejected.
 */
export function validateConfigPatch(
  profile: ProfileConfig,
  ops: ConfigPatchOp[] | null | undefined,
  repair?: RepairConfig
): PatchValidation {
  const errors: string[] = [];
  if (!Array.isArray(ops) || !ops.length) {
    return { ok: false, errors: ["patch must be a non-empty array of {path, value} ops"] };
  }
  const mutablePaths = repair?.mutablePaths ?? DEFAULT_REPAIR_MUTABLE_PATHS;
  const allowNewKeys = repair?.allowNewKeys ?? DEFAULT_REPAIR_ALLOW_NEW_KEYS;
  const knownVars = [
    ...BUILTIN_IDENTITY_VARS,
    "project",
    "org",
    ...Object.keys(profile.ziki?.vars ?? {})
  ];  for (const [index, op] of ops.entries()) {
    const label = `ops[${index}]`;
    if (!op || typeof op !== "object" || typeof op.path !== "string" || !op.path.trim()) {
      errors.push(`${label} must have a non-empty string path`);
      continue;
    }
    const opPath = op.path.trim();
    if (isNeverMutablePath(opPath)) {
      errors.push(`${label} touches a protected path and can never be agent-modified: ${opPath}`);
      continue;
    }
    if (!pathMatchesAllowlist(opPath, mutablePaths)) {
      errors.push(`${label} is outside the repair allowlist: ${opPath}`);
      continue;
    }
    const existing = getConfigPath(profile, opPath);
    // Overriding a known registry endpoint needs no new-key permission: the
    // default registry is the source of truth and the fallback is identical.
    let isKnownEndpoint = false;
    if (opPath === "ziki.endpoints" || opPath.startsWith("ziki.endpoints.")) {
      const parts = opPath === "ziki.endpoints" ? [] : opPath.slice("ziki.endpoints.".length).split(".");
      const group = templateEndpoints()[parts[0]!] as Record<string, string> | undefined;
      isKnownEndpoint = parts.length === 0 || (!!group && (parts.length === 1 || parts.slice(1).join(".") in group));
    }
    const isNewVarsKey = opPath.startsWith("ziki.vars.") && existing === undefined;
    // Known timing knobs always exist after defaults merge, so proposals
    // against them need no new-key permission either.
    const timingKey = opPath === "timing" ? "" : opPath.startsWith("timing.") ? opPath.slice("timing.".length) : null;
    const isKnownTiming = timingKey !== null && (timingKey === "" || timingKey in TIMING_MIN_MS || timingKey === "heartbeatMs");
    if (existing === undefined && !allowNewKey(opPath, allowNewKeys) && !isNewVarsKey && !isKnownEndpoint && !isKnownTiming) {
      errors.push(`${label} creates a new key not in repair.allowNewKeys: ${opPath}`);
      continue;
    }
    // New queue priorities must be numbers: a string priority would silently
    // mis-sort the new kind instead of failing loud.
    if (existing === undefined && opPath.startsWith("queue.priorities.")) {
      if (typeof op.value !== "number" || !Number.isFinite(op.value)) {
        errors.push(`${label} queue priority values must be numbers: ${opPath}`);
        continue;
      }
    }
    if (existing !== undefined && existing !== null && op.value !== undefined && op.value !== null) {
      const expected = Array.isArray(existing) ? "array" : typeof existing;
      const actual = Array.isArray(op.value) ? "array" : typeof op.value;
      if (expected !== actual) {
        errors.push(`${label} changes the type of ${opPath} from ${expected} to ${actual}`);
      }
    }
    if (opPath === "ziki.vars" || opPath.startsWith("ziki.vars.")) {
      const varsErrors = validateEndpointVars(
        opPath === "ziki.vars" ? op.value : { [opPath.slice("ziki.vars.".length)]: op.value },
        label
      );
      errors.push(...varsErrors);
    }
    if (opPath === "ziki.endpoints" || opPath.startsWith("ziki.endpoints.")) {
      const single =
        opPath === "ziki.endpoints" ? op.value : nestEndpointPath(opPath, op.value);
      errors.push(...validateEndpoints(single as Record<string, Record<string, string>>, knownVars, label));
      continue;
    }
    if (opPath === "timing" || opPath.startsWith("timing.")) {
      const entries: Array<[string, unknown]> =
        opPath === "timing" && isPlainObject(op.value)
          ? Object.entries(op.value)
          : [[opPath.slice("timing.".length), op.value]];
      for (const [key, value] of entries) {
        if (key === "heartbeatMs" && value === null) continue;
        const floor = TIMING_MIN_MS[key];
        if (floor === undefined) {
          errors.push(`${label} targets unknown timing knob: ${key}`);
        } else {
          const problem = checkTimingValue(key, value, floor);
          if (problem) errors.push(`${label}.${problem}`);
        }
      }
      continue;
    }
    try {
      JSON.stringify(op.value);
    } catch {
      errors.push(`${label} value for ${opPath} is not JSON-serializable`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Nest a dotted endpoints op (`ziki.endpoints.issues.list`) back into object form for validation. */
function nestEndpointPath(opPath: string, value: unknown): unknown {
  const parts = opPath.slice("ziki.endpoints.".length).split(".");
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next: Record<string, unknown> = {};
    current[parts[index]!] = next;
    current = next;
  }
  current[parts[parts.length - 1]!] = value;
  return root;
}

/**
 * Fresh-install skeleton: version 4 with no profiles and no behavioural
 * defaults. Every behavioural value comes from config/init-templates.json
 * via stampV4/migrate (init) or the in-memory fill (loadProfile) — never
 * from literals here. `doctor.minFreeGb` is the only knob: a local disk
 * safety floor, not Ziki behaviour.
 */
export function defaultConfig(): Config {
  return {
    version: 4,
    activeProfile: "",
    defaults: {},
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
  if (version !== 3 && version !== 4) {
    throw new Error(
      `Config ${p.configFile} is version ${Number.isFinite(version) ? version : "unknown"}; this release uses version 3 or 4. ` +
        "Run `auto-work migrate` to move a v3 config to v4, or `auto-work init` to write a new config."
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

  if (Number(config.version) !== 3 && Number(config.version) !== 4) errors.push("version must be 3 or 4");
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
    if (profile?.ziki?.orgSlug !== undefined && (typeof profile.ziki.orgSlug !== "string" || !profile.ziki.orgSlug.trim())) {
      errors.push(`${prefix}.ziki.orgSlug must be a non-empty string when set`);
    }
  errors.push(...validateZikiStatuses(profile?.statuses, `${prefix}.statuses`));
  errors.push(
    ...validateEndpointVars(profile?.ziki?.vars, `${prefix}.ziki.vars`),
      ...validateEndpoints(profile?.ziki?.endpoints, [
        ...BUILTIN_IDENTITY_VARS,
        "project",
        "org",
        ...Object.keys(profile?.ziki?.vars ?? {})
      ], `${prefix}.ziki.endpoints`)
    );
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
  errors.push(...validateTiming(profile?.timing, `${prefix}.timing`));
  errors.push(...validateHealthRetry(profile?.health?.retryMs, `${prefix}.health.retryMs`));
  errors.push(...validateCycleErrorLimit(profile?.health?.cycleErrorLimit, `${prefix}.health.cycleErrorLimit`));
    validateRepairConfig(prefix, profile?.repair, errors);
    errors.push(...validateV4Sections(profile, `${prefix}`));
    if (Number(config.version) === 4) {
      errors.push(...validateV4Required(profile, `${prefix}`));
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

export function validateZikiStatuses(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${label} must be an object with workable/terminal lists`];
  }
  const record = value as Record<string, unknown>;
  for (const key of ["workable", "terminal", "terminalSubstatus", "confirmation", "known"]) {
    if (record[key] === undefined) continue;
    if (!stringList(record[key])) errors.push(`${label}.${key} must be an array of non-empty strings`);
  }
  return errors;
}

const TIMING_MIN_MS: Record<string, number> = {
  agentDefaultMs: 60_000,
  triageMs: 60_000,
  ownerMs: 60_000,
  discoveryMs: 60_000,
  repairMs: 30_000,
  doctorMs: 30_000,
  markRecentMs: 60_000,
  offlineWatchMs: 60_000,
  offlineFreshMs: 60_000,
  repoHealthMs: 3_600_000,
  heartbeatDefaultMs: 60_000,
  reviewTransientMs: 60_000,
  reviewTerminalMs: 60_000,
  rateLimitChunkMs: 1000
};

export function validateTiming(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${label} must be an object of millisecond durations`];
  }
  const record = value as Record<string, unknown>;
  if (record.heartbeatMs !== undefined && record.heartbeatMs !== null &&
    (typeof record.heartbeatMs !== "number" || !Number.isFinite(record.heartbeatMs) || record.heartbeatMs <= 0)) {
    errors.push(`${label}.heartbeatMs must be a positive number of ms, or null to derive from Ziki`);
  }
  for (const [key, min] of Object.entries(TIMING_MIN_MS)) {
    const entry = record[key];
    if (entry === undefined) continue;
    const problem = checkTimingValue(key, entry, min);
    if (problem) errors.push(`${label}.${problem}`);
  }
  for (const key of Object.keys(record)) {
    if (!(key in TIMING_MIN_MS) && key !== "heartbeatMs") {
      errors.push(`${label}.${key} is not a known timing knob`);
    }
  }
  return errors;
}

function checkTimingValue(key: string, value: unknown, min: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    return `${key} must be a number >= ${min}ms`;
  }
  return null;
}

export function validateHealthRetry(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${label} must be an object of blocker code -> ms (or null for built-in)`];
  }
  const errors: string[] = [];
  for (const [code, ms] of Object.entries(value as Record<string, unknown>)) {
    if (ms !== null && (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)) {
      errors.push(`${label}[${JSON.stringify(code)}] must be a non-negative number of ms or null`);
    }
  }
  return errors;
}

export function validateCycleErrorLimit(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return [`${label} must be a positive integer or null`];
  }
  return [];
}

function validateRepairConfig(prefix: string, repair: RepairConfig | undefined, errors: string[]): void {
  if (repair === undefined) return;
  if (typeof repair !== "object" || repair === null || Array.isArray(repair)) {
    errors.push(`${prefix}.repair must be an object`);
    return;
  }
  if (repair.enabled !== undefined && typeof repair.enabled !== "boolean") {
    errors.push(`${prefix}.repair.enabled must be a boolean`);
  }
  for (const field of ["mutablePaths", "allowNewKeys"] as const) {
    const list = (repair as Record<string, unknown>)[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string" || !entry.trim())) {
      errors.push(`${prefix}.repair.${field} must be an array of non-empty strings`);
      continue;
    }
    for (const entry of list as string[]) {
      if (isNeverMutablePath(entry.trim())) {
        errors.push(
          `${prefix}.repair.${field} entry "${entry.trim()}" is protected and can never be agent-modified`
        );
      }
    }
  }
  const strategies = repair.strategies;
  if (strategies === undefined) return;
  if (typeof strategies !== "object" || strategies === null || Array.isArray(strategies)) {
    errors.push(`${prefix}.repair.strategies must be an object keyed by health-blocker code`);
    return;
  }
  for (const [code, strategy] of Object.entries(strategies)) {
    const sprefix = `${prefix}.repair.strategies[${JSON.stringify(code)}]`;
    if (typeof strategy !== "object" || strategy === null || Array.isArray(strategy)) {
      errors.push(`${sprefix} must be an object`);
      continue;
    }
    if (strategy.enabled !== undefined && typeof strategy.enabled !== "boolean") {
      errors.push(`${sprefix}.enabled must be a boolean`);
    }
    if (strategy.role !== undefined && (typeof strategy.role !== "string" || !strategy.role.trim())) {
      errors.push(`${sprefix}.role must be a non-empty agent role name`);
    }
    if (
      strategy.maxRounds !== undefined &&
      strategy.maxRounds !== null &&
      (!Number.isInteger(strategy.maxRounds) || strategy.maxRounds < 1)
    ) {
      errors.push(`${sprefix}.maxRounds must be a positive integer or null`);
    }
    if (strategy.match !== undefined && (typeof strategy.match !== "object" || strategy.match === null)) {
      errors.push(`${sprefix}.match must be an object of strategy hints`);
    }
  }
}

const V4_OBJECT_SECTIONS = [
  "transport",
  "queue",
  "reviewGate",
  "heartbeatPolicy",
  "decisions",
  "noop",
  "votes",
  "idea",
  "apiRepair",
  "capacity",
  "urls",
  "discover",
  "github",
  "safety",
  "checksDefaults",
  "outbox",
  "bootstrap",
  "loop"
] as const;

const V4_REQUIRED_IN_V4 = ["transport", "operations"] as const;

/**
 * v4 section validation (light in P1 — presence + shape; per-section
 * strictness lands with the P2 phase that consumes each section).
 * v3 configs skip this entirely. v4 configs must carry transport +
 * operations; all other new sections warn when absent until their P2
 * phase flips them to required.
 */
const V4_REQUIRED_SECTIONS = [
  "transport",
  "queue",
  "reviewGate",
  "heartbeatPolicy",
  "decisions",
  "noop",
  "votes",
  "idea",
  "apiRepair",
  "capacity",
  "urls",
  "discover",
  "github",
  "safety",
  "checksDefaults",
  "outbox",
  "bootstrap",
  "offline",
  "loop",
  "pr",
  "repo",
  "discovery"
] as const;

export function validateV4Required(profile: ProfileConfig, prefix: string): string[] {
  const errors: string[] = [];
  const record = profile as unknown as Record<string, unknown>;
  for (const section of V4_REQUIRED_SECTIONS) {
    const value = record[section];
    if (value === undefined) {
      errors.push(`${prefix}.${section} is required in v4 (run \`auto-work migrate\`)`);
    } else if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${prefix}.${section} must be an object (run \`auto-work migrate\`)`);
    }
  }
  if ((profile.ziki as unknown as Record<string, unknown> | undefined)?.endpoints === undefined) {
    errors.push(`${prefix}.ziki.endpoints is required in v4 (run \`auto-work migrate\`)`);
  }
  if (typeof profile.pr?.maxBodyChars !== "number") {
    errors.push(`${prefix}.pr.maxBodyChars must be a number (run \`auto-work migrate\`)`);
  }
  if (profile.repo?.mergeMode !== undefined && !["handoff", "never", "auto"].includes(profile.repo.mergeMode)) {
    errors.push(`${prefix}.repo.mergeMode must be "handoff", "never" or "auto"`);
  }
  if (profile.repo?.mergeMethod !== undefined && !["merge", "squash", "rebase"].includes(profile.repo.mergeMethod)) {
    errors.push(`${prefix}.repo.mergeMethod must be "merge", "squash" or "rebase"`);
  }
  return errors;
}

export function validateV4Sections(profile: ProfileConfig, prefix: string): string[] {
  if (!profile) return [];
  const errors: string[] = [];
  const record = profile as unknown as Record<string, unknown>;
  // Detect v4 intent: transport or operations present means v4 rules apply.
  const isV4 = record.transport !== undefined || record.operations !== undefined;
  for (const section of V4_OBJECT_SECTIONS) {
    const value = record[section];
    if (value === undefined) {
      if (isV4 && (V4_REQUIRED_IN_V4 as readonly string[]).includes(section)) {
        errors.push(`${prefix}.${section} is required in v4 (run \`auto-work migrate\`)`);
      }
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${prefix}.${section} must be an object`);
    }
  }
  const operations = record.operations;
  if (operations === undefined) {
    if (isV4) errors.push(`${prefix}.operations is required in v4 (run \`auto-work migrate\`)`);
  } else if (typeof operations !== "object" || operations === null || Array.isArray(operations)) {
    errors.push(`${prefix}.operations must be an object of group -> name -> operation`);
  } else {
    for (const [group, names] of Object.entries(operations as Record<string, unknown>)) {
      if (typeof names !== "object" || names === null || Array.isArray(names)) {
        errors.push(`${prefix}.operations.${group} must be an object of name -> operation`);
        continue;
      }
      for (const [name, op] of Object.entries(names as Record<string, unknown>)) {
        const where = `${prefix}.operations.${group}.${name}`;
        if (typeof op !== "object" || op === null || Array.isArray(op)) {
          errors.push(`${where} must be an object`);
          continue;
        }
        const method = (op as Record<string, unknown>).method;
        if (method !== undefined && (typeof method !== "string" || !method.trim())) {
          errors.push(`${where}.method must be a non-empty string`);
        }
        const expect = (op as Record<string, unknown>).expect;
        if (expect !== undefined && !["feed", "list", "object"].includes(expect as string)) {
          errors.push(`${where}.expect must be "feed", "list" or "object"`);
        }
      }
    }
  }
  return errors;
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
  const mode = profile.repo.mergeMode;
  if (mode !== "handoff" && mode !== "never" && mode !== "auto") {
    throw new Error('profile.repo.mergeMode must be "handoff", "never" or "auto" (run `auto-work migrate`)');
  }
  return mode;
}

export function resolveMergeMethod(profile: ProfileConfig): "merge" | "squash" | "rebase" {
  const method = profile.repo.mergeMethod;
  if (method !== "merge" && method !== "squash" && method !== "rebase") {
    throw new Error('profile.repo.mergeMethod must be "merge", "squash" or "rebase" (run `auto-work migrate`)');
  }
  return method;
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
  const merged = deepMerge(config.defaults ?? {}, rawProfile) as ProfileConfig;
  merged.providers = { ...(config.providers ?? {}), ...(merged.providers ?? {}) };
  // Behavioural values are data-filled from init templates (never code
  // literals), so unmigrated profiles keep working with template-sourced
  // values. `config --explain` reports this provenance; `migrate` persists
  // it to disk.
  const { loadInitTemplates, fillProfileFromTemplates } = await import("./config-templates.js");
  const templates = await loadInitTemplates();
  const { profile } = fillProfileFromTemplates(merged, templates);
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
