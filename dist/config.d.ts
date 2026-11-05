import type { Config, ProfileConfig, ProfilePaths, LimitsConfig, LoadedProfile, ProviderName, PushMode, Role, RunLimitConfig, WorkflowConfig } from "./types.js";
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
