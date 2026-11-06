export interface MergeGatePolicy {
    openState: string;
    passingChecks: string;
    noneChecks: string;
    changesRequested: string;
    approved: string;
}
export interface MergeGateInput {
    zikiReady: boolean;
    checks: string;
    mergeable: boolean | null;
    merged: boolean;
    state: string;
    reviewDecision: string | null;
    approvedReviews: number;
    requiredReviewers?: number;
    requiredApprovals?: number;
    policy: MergeGatePolicy;
}
export declare function mergeGateReason(input: MergeGateInput): string | null;
