import type { ProviderLimit } from "./types.js";
export declare function normalizeProviderLimit(value: unknown): ProviderLimit;
export declare function providerLimitForResult(parsed: {
    ok?: boolean;
    blocked?: boolean;
    providerLimit?: unknown;
} | null | undefined, failed: boolean): ProviderLimit;
