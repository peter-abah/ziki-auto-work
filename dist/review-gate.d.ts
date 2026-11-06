import type { ReviewGatePolicyConfig } from "./types.js";
export interface ReviewGateStatus {
    state: string;
    merged: boolean;
    checks: string;
    mergeable: boolean | null;
    isDraft?: boolean;
}
export interface ReviewGateInput {
    status: ReviewGateStatus | null;
    goodVerdicts?: number;
    verdictsNeeded?: number | null;
    policy: ReviewGatePolicyConfig;
}
export interface ReviewGateResult {
    ok: boolean;
    reason?: string;
    recentMs?: number;
}
export declare function verdictsNeeded(workflow: Record<string, unknown> | null | undefined, keys?: readonly string[]): number | null;
export interface VerdictLike {
    goodToMerge?: boolean;
    current?: boolean;
    agentId?: string;
    id?: string;
}
export declare function countGoodVerdicts(verdicts: ReadonlyArray<VerdictLike>): number;
export declare function reviewGate(input: ReviewGateInput): ReviewGateResult;
