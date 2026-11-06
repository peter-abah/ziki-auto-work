function requirePolicy(policy) {
    const fallback = policy?.defaultPolicy;
    const defaultPolicy = fallback === "off" || fallback === "agent" || fallback === "heuristic" ? fallback : "agent";
    const bidMinChars = policy?.bidMinChars;
    const bidKeywords = policy?.bidKeywords;
    const commentKeywords = policy?.commentKeywords;
    if (typeof bidMinChars !== "number" || !Number.isFinite(bidMinChars) || bidMinChars < 0) {
        throw new Error("votes.bidMinChars must be a non-negative number (run `auto-work migrate`)");
    }
    for (const [key, value] of [["bidKeywords", bidKeywords], ["commentKeywords", commentKeywords]]) {
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
            throw new Error(`votes.${key} must be an array of strings (run \`auto-work migrate\`)`);
        }
    }
    return { defaultPolicy, bidMinChars, bidKeywords: bidKeywords, commentKeywords: commentKeywords };
}
export function resolveVotePolicy(value, policy) {
    if (value === "off" || value === "agent" || value === "heuristic")
        return value;
    const fallback = policy?.defaultPolicy;
    if (fallback === "off" || fallback === "agent" || fallback === "heuristic")
        return fallback;
    return "agent";
}
export function heuristicBidVote(detail, policy) {
    const resolved = requirePolicy(policy);
    const text = (detail ?? "").toLowerCase();
    if (text.length < resolved.bidMinChars)
        return false;
    return resolved.bidKeywords.some((word) => text.includes(word.toLowerCase()));
}
export function heuristicCommentVote(detail, policy) {
    const resolved = requirePolicy(policy);
    const text = (detail ?? "").toLowerCase();
    return resolved.commentKeywords.some((word) => text.includes(word.toLowerCase()));
}
//# sourceMappingURL=votes.js.map