export interface MergeGateInput {
    zikiReady: boolean;
    checks: "passing" | "failing" | "pending" | "none";
    mergeable: boolean | null;
    merged: boolean;
    state: string;
    reviewDecision: string | null;
    approvedReviews: number;
    requiredReviewers?: number;
    requiredApprovals?: number;
}
export declare function mergeGateReason(input: MergeGateInput): string | null;
