import type { Config, ConfigPatchOp, ProfileConfig, ProfilePaths, LimitsConfig, LoadedProfile, ProviderName, PushMode, RepairConfig, RepairStrategyConfig, Role, RunLimitConfig, WorkflowConfig } from "./types.js";
import { expandHome } from "./platform/paths.js";
export declare const PROVIDERS: ProviderName[];
export declare const DEFAULT_LIMITS: LimitsConfig;
export declare const DEFAULT_RUN_LIMITS: {
    maxRuntimeMinutes: null;
    maxCycles: null;
    stopAt: null;
    maxDeliveriesTotal: null;
};
export declare const DEFAULT_PR_TRACKING: {
    enabled: boolean;
    pollMinutes: number;
    maxFollowUps: number;
    fixFailingChecks: boolean;
    fixReviewComments: boolean;
};
export declare const DEFAULT_WORKFLOW: WorkflowConfig;
export declare const DEFAULT_ENV_FILES: string[];
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
export declare const DEFAULT_REPAIR_MUTABLE_PATHS: string[];
export declare const DEFAULT_REPAIR_ALLOW_NEW_KEYS: string[];
export declare const DEFAULT_ZIKI_STATUSES: {
    workable: string[];
    terminal: string[];
    terminalSubstatus: string[];
    confirmation: string[];
    known: string[];
};
export declare const DEFAULT_TIMING: {
    agentDefaultMs: number;
    triageMs: number;
    ownerMs: number;
    discoveryMs: number;
    repairMs: number;
    doctorMs: number;
    markRecentMs: number;
    offlineWatchMs: number;
    offlineFreshMs: number;
    repoHealthMs: number;
    heartbeatMs: number | null;
    heartbeatDefaultMs: number;
    reviewTransientMs: number;
    reviewTerminalMs: number;
    rateLimitChunkMs: number;
};
export declare const DEFAULT_REPAIR_STRATEGIES: Record<string, RepairStrategyConfig>;
export declare function isNeverMutablePath(path: string): boolean;
/** Read a dot-path (`ziki.projectId`) from a profile object. */
export declare function getConfigPath(obj: unknown, path: string): unknown;
/** Return a deep clone of `obj` with the dot-path set to `value`. */
export declare function setConfigPath<T>(obj: T, path: string, value: unknown): T;
export interface PatchValidation {
    ok: boolean;
    errors: string[];
}
/**
 * Validate an agent-proposed patch WITHOUT applying it. Fails closed:
 * unknown paths, denylisted paths, new keys outside allowNewKeys, and
 * type changes are all rejected.
 */
export declare function validateConfigPatch(profile: ProfileConfig, ops: ConfigPatchOp[] | null | undefined, repair?: RepairConfig): PatchValidation;
export declare function defaultConfig(): Config;
export declare function deepMerge<T>(base: T, override: unknown): T;
export declare function parseEnvFile(text: string): Record<string, string>;
export declare function loadEnv(): Promise<Record<string, string>>;
export declare function saveEnv(values: Record<string, string>): Promise<void>;
export declare function sampleConfigPath(name: string): string;
export declare function loadConfig(): Promise<Config>;
export declare function saveConfig(config: Config): Promise<void>;
export interface ValidationResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
}
export declare function inferPushMode(forkOwner: string, upstreamOwner: string, user?: string | null): PushMode;
export declare function validateConfig(config: Config): ValidationResult;
export declare function validateZikiStatuses(value: unknown, label: string): string[];
export declare function validateTiming(value: unknown, label: string): string[];
export declare function validateHealthRetry(value: unknown, label: string): string[];
export declare function validateV4Required(profile: ProfileConfig, prefix: string): string[];
export declare function validateV4Sections(profile: ProfileConfig, prefix: string): string[];
export declare function resolveRunLimits(profile: ProfileConfig, override?: Partial<RunLimitConfig> | null): RunLimitConfig;
export declare function resolveModel(profile: ProfileConfig, role: Role): string | null;
export declare function resolveMergeMode(profile: ProfileConfig): "handoff" | "never" | "auto";
export declare function resolveMergeMethod(profile: ProfileConfig): "merge" | "squash" | "rebase";
export declare function resolvePromptDir(profile: ProfileConfig): string;
export declare function resolvePrTemplate(profile: ProfileConfig): string;
export declare function resolveParityFile(profile: ProfileConfig): string | null;
export declare function ensureProfileDirs(profilePathsValue: ProfilePaths): Promise<void>;
export declare function loadProfile(profileName?: string): Promise<LoadedProfile>;
export { expandHome };
