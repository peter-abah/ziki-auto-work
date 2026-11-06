import type { NoopPolicyConfig } from "./types.js";
export interface NoopPolicy {
    statuses?: number[];
    patterns?: Record<string, string[]>;
}
export declare function resolvePatterns(policy: NoopPolicy | NoopPolicyConfig | null | undefined): Record<string, RegExp[]>;
export declare function errorMessage(error: unknown): string;
export declare function isNoopZikiError(error: unknown, patterns: ReadonlyArray<RegExp>, policy: NoopPolicy | NoopPolicyConfig | null | undefined): boolean;
/** Resolve one action's compiled patterns (e.g. "reclaim") from policy. */
export declare function noopPatterns(policy: NoopPolicy | NoopPolicyConfig | null | undefined, action: string): RegExp[];
