export const DECISION_MARKER = "**Decision from the owner:**";
function markerBody(body) {
    const index = body.indexOf(DECISION_MARKER);
    if (index < 0)
        return null;
    return body.slice(index + DECISION_MARKER.length).trim();
}
function sentences(text) {
    return text
        .replace(/\r/g, "")
        .split(/(?<=[.!?])\s+|\n+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
}
function answerFor(text, kind) {
    const lower = text.toLowerCase();
    if (!lower.includes(kind))
        return null;
    if (/\b(do not|don't|dont|not|no|reject|decline|deny|cancel|stop)\b/.test(lower))
        return false;
    if (/\b(yes|yeah|yep|approve|approved|confirm|merge|proceed|go ahead|do it|accept)\b/.test(lower))
        return true;
    return null;
}
export function parseOwnerDecisions(comments) {
    const decisions = [];
    for (const comment of comments ?? []) {
        const body = markerBody(String(comment.body ?? ""));
        if (!body)
            continue;
        const parts = sentences(body);
        const found = new Map();
        for (const sentence of parts) {
            for (const kind of ["confirm", "merge"]) {
                if (found.has(kind))
                    continue;
                const answer = answerFor(sentence, kind);
                if (answer === null)
                    continue;
                found.set(kind, answer);
                decisions.push({
                    kind,
                    answer,
                    text: sentence,
                    at: comment.createdAt,
                    author: comment.authorName ?? comment.by
                });
            }
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