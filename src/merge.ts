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

export function mergeGateReason(input: MergeGateInput): string | null {
  if (!input.zikiReady) return "Ziki has not accepted the fix yet";
  if (input.merged) return "the pull request is already merged";
  if (input.state !== "OPEN") return `the pull request is ${input.state.toLowerCase()}`;
  if (input.checks !== "passing" && input.checks !== "none") return `checks are ${input.checks}`;
  if (input.mergeable === false) return "the pull request has a merge conflict";
  if (input.reviewDecision === "CHANGES_REQUESTED") return "changes are still requested";
  const required = input.requiredApprovals ?? input.requiredReviewers ?? 0;
  if (input.reviewDecision !== "APPROVED" && input.approvedReviews < Math.max(1, required)) {
    return "required approvals are missing";
  }
  if (required > 0 && input.approvedReviews < required) return "required approvals are missing";
  return null;
}
