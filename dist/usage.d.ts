import type { ProviderUsageConfig, TokenUsage } from "./types.js";
export declare function emptyUsage(): TokenUsage;
export declare function addUsage(a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage;
export declare function parseUsage(text: string | undefined, config?: ProviderUsageConfig): TokenUsage | null;
export declare function formatTokens(value: number): string;
export declare function usagePercent(used: number, limit: number | null | undefined): number | null;
