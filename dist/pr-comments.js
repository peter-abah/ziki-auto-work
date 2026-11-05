function isBot(author) {
    return author.trim().toLowerCase().endsWith("[bot]");
}
function mentions(body, names) {
    const lower = body.toLowerCase();
    return names.some((name) => name && lower.includes(`@${name.toLowerCase()}`));
}
function startsWithCommand(body) {
    const first = body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return first === "/fix" || first === "!fix" || first === "@auto-work";
}
export function isActionablePrComment(comment, policy) {
    const body = comment.body.trim();
    if (!body)
        return false;
    if (isBot(comment.author))
        return false;
    if (comment.kind === "review" && (comment.path || comment.line))
        return true;
    if (startsWithCommand(body))
        return true;
    return mentions(body, policy.mentions);
}
export function actionablePrComments(comments, handledAt, policy) {
    const cutoff = handledAt ? Date.parse(handledAt) : 0;
    return comments.filter((comment) => {
        if (!isActionablePrComment(comment, policy))
            return false;
        const at = Date.parse(comment.createdAt ?? "") || 0;
        return at > (Number.isFinite(cutoff) ? cutoff : 0);
    });
}
//# sourceMappingURL=pr-comments.js.map