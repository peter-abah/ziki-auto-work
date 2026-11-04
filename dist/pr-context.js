function clip(value, max) {
    const text = value === undefined || value === null ? "" : String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
export function formatPrContext(status, extraComments = [], checkLogs = [], maxChars = 14_000) {
    const comments = [...status.comments, ...extraComments]
        .filter((comment) => comment.body.trim())
        .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
        .slice(-40);
    const parts = [];
    parts.push([
        `- URL: ${status.url}`,
        `- State: ${status.merged ? "merged" : status.state}`,
        `- Head: ${status.headSha ?? "unknown"} (${status.headRefName ?? "?"})`,
        `- Base: ${status.baseRefName ?? "?"}`,
        `- Checks: ${status.checks}`,
        `- Mergeable: ${status.mergeable === null ? "unknown" : String(status.mergeable)}`,
        `- Review decision: ${status.reviewDecision ?? "unknown"}`
    ].join("\n"));
    if (status.checkRuns.length) {
        parts.push(`## Checks\n${status.checkRuns
            .map((check) => `- ${check.name}: ${check.conclusion ?? check.status}${check.url ? ` (${check.url})` : ""}`)
            .join("\n")}`);
    }
    if (status.reviews.length) {
        parts.push(`## Reviews\n${status.reviews
            .map((review) => `- ${review.author}: ${review.state}${review.submittedAt ? ` at ${review.submittedAt}` : ""}\n  ${clip(review.body, 800)}`)
            .join("\n")}`);
    }
    if (comments.length) {
        parts.push(`## Comments and review threads\n${comments
            .map((comment) => {
            const location = comment.path ? ` ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
            return `- [${comment.kind}] id=${comment.id} ${comment.author}${location}${comment.createdAt ? ` at ${comment.createdAt}` : ""}\n  ${clip(comment.body, 1500)}`;
        })
            .join("\n")}`);
    }
    if (checkLogs.length) {
        parts.push(`## Failed check output\n${checkLogs
            .map((entry) => `### ${entry.name}\n\`\`\`\n${clip(entry.log, 6000)}\n\`\`\``)
            .join("\n")}`);
    }
    const text = parts.join("\n\n") || "(no PR details)";
    return clip(text, maxChars);
}
//# sourceMappingURL=pr-context.js.map