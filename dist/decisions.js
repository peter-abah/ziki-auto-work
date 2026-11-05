export const DECISION_MARKER = "**Decision from the owner:**";
function markerBody(body) {
    const index = body.indexOf(DECISION_MARKER);
    if (index < 0)
        return null;
    return body.slice(index + DECISION_MARKER.length).trim();
}
function stripPunctuation(value) {
    let text = value.trim();
    while (text && ".,;!`*\"'".includes(text.at(-1)))
        text = text.slice(0, -1).trim();
    return text;
}
function cleanKey(key) {
    let text = key.trim();
    while (text && "*`\"'".includes(text[0]))
        text = text.slice(1);
    while (text && "*`\"'".includes(text.at(-1)))
        text = text.slice(0, -1);
    return text.trim();
}
function decisionKind(key) {
    const text = cleanKey(key).toLowerCase();
    for (const kind of ["confirm", "merge"]) {
        if (text === kind || text.startsWith(`${kind} `) || text.startsWith(`${kind}#`))
            return kind;
    }
    return null;
}
function decisionAnswer(value) {
    let text = value.trim();
    while (text && "*`\"'".includes(text[0]))
        text = text.slice(1).trim();
    text = stripPunctuation(text).toLowerCase();
    if (text === "yes" || text === "y" || text === "true")
        return true;
    if (text === "no" || text === "n" || text === "false")
        return false;
    return null;
}
function labelledDecisions(body) {
    const found = [];
    for (const line of body.split(/\r?\n/)) {
        for (const segment of line.split(",")) {
            const separator = segment.indexOf(":");
            const equals = segment.indexOf("=");
            const at = separator >= 0 ? separator : equals;
            if (at < 0)
                continue;
            const kind = decisionKind(segment.slice(0, at));
            if (!kind)
                continue;
            const answer = decisionAnswer(segment.slice(at + 1));
            if (answer === null)
                continue;
            found.push({ kind, answer, text: segment.trim() });
        }
    }
    return found;
}
export function parseOwnerDecisions(comments) {
    const decisions = [];
    for (const comment of comments ?? []) {
        const body = markerBody(String(comment.body ?? ""));
        if (!body)
            continue;
        for (const entry of labelledDecisions(body)) {
            decisions.push({
                kind: entry.kind,
                answer: entry.answer,
                text: entry.text,
                at: comment.createdAt,
                author: comment.authorName ?? comment.by
            });
        }
    }
    return decisions;
}
export function latestDecision(decisions, kind) {
    const matching = decisions.filter((decision) => decision.kind === kind);
    return matching.at(-1) ?? null;
}
export function formatOwnerDecisions(decisions) {
    if (!decisions.length)
        return "(none)";
    return decisions
        .map((decision) => `- ${decision.kind}: ${decision.answer ? "yes" : "no"} — ${decision.text}${decision.author ? ` (${decision.author})` : ""}`)
        .join("\n");
}
//# sourceMappingURL=decisions.js.map