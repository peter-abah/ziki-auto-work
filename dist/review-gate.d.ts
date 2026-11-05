export interface ReviewGateStatus {
    state: string;
    merged: boolean;
    checks: "passing" | "failing" | "pending" | "none";
    mergeable: boolean | null;
    isDraft?: boolean;
}
export interface ReviewGateInput {
    status: ReviewGateStatus | null;
    goodVerdicts?: number;
    verdictsNeeded?: number | null;
}
export interface ReviewGateResult {
    ok: boolean;
    reason?: string;
    recentMs?: number;
}
export declare function verdictsNeeded(workflow: Record<string, unknown> | null | undefined): number | null;
export interface VerdictLike {
    goodToMerge?: boolean;
    current?: boolean;
    agentId?: string;
    id?: string;
}
export declare function countGoodVerdicts(verdicts: ReadonlyArray<VerdictLike>): number;
export declare function reviewGate(input: ReviewGateInput): ReviewGateResult;
