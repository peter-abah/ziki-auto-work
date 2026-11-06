function requirePolicy(policy) {
    if (!policy || typeof policy !== "object") {
        throw new Error("merge gate policy is required (run `auto-work migrate`)");
    }
    for (const key of ["openState", "passingChecks", "noneChecks", "changesRequested", "approved"]) {
        if (typeof policy[key] !== "string" || !policy[key]) {
            throw new Error(`merge gate policy.${key} must be a non-empty string (run \`auto-work migrate\`)`);
        }
    }
    return policy;
}
export function mergeGateReason(input) {
    const policy = requirePolicy(input.policy);
    if (!input.zikiReady)
        return "Ziki has not accepted the fix yet";
    if (input.merged)
        return "the pull request is already merged";
    if (input.state !== policy.openState)
        return `the pull request is ${input.state.toLowerCase()}`;
    if (input.checks !== policy.passingChecks && input.checks !== policy.noneChecks)
        return `checks are ${input.checks}`;
    if (input.mergeable === false)
        return "the pull request has a merge conflict";
    if (input.reviewDecision === policy.changesRequested)
        return "changes are still requested";
    const required = input.requiredApprovals ?? input.requiredReviewers ?? 0;
    if (input.reviewDecision !== policy.approved && input.approvedReviews < Math.max(1, required)) {
        return "required approvals are missing";
    }
    if (required > 0 && input.approvedReviews < required)
        return "required approvals are missing";
    return null;
}
//# sourceMappingURL=merge.js.map