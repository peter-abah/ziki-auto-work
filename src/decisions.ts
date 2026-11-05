import type { Comment, OwnerDecision } from "./types.js";

export const DECISION_MARKER = "**Decision from the owner:**";

function markerBody(body: string): string | null {
  const index = body.indexOf(DECISION_MARKER);
  if (index < 0) return null;
  return body.slice(index + DECISION_MARKER.length).trim();
}

function stripPunctuation(value: string): string {
  let text = value.trim();
  while (text && ".,;!`*\"'".includes(text.at(-1)!)) text = text.slice(0, -1).trim();
  return text;
}

function cleanKey(key: string): string {
  let text = key.trim();
  while (text && "*`\"'".includes(text[0]!)) text = text.slice(1);
  while (text && "*`\"'".includes(text.at(-1)!)) text = text.slice(0, -1);
  return text.trim();
}

function decisionKind(key: string): "confirm" | "merge" | null {
  const text = cleanKey(key).toLowerCase();
  for (const kind of ["confirm", "merge"] as const) {
    if (text === kind || text.startsWith(`${kind} `) || text.startsWith(`${kind}#`)) return kind;
  }
  return null;
}

function decisionAnswer(value: string): boolean | null {
  let text = value.trim();
  while (text && "*`\"'".includes(text[0]!)) text = text.slice(1).trim();
  text = stripPunctuation(text).toLowerCase();
  if (text === "yes" || text === "y" || text === "true") return true;
  if (text === "no" || text === "n" || text === "false") return false;
  return null;
}

function labelledDecisions(body: string): Array<{ kind: "confirm" | "merge"; answer: boolean; text: string }> {
  const found: Array<{ kind: "confirm" | "merge"; answer: boolean; text: string }> = [];
  for (const line of body.split(/\r?\n/)) {
    for (const segment of line.split(",")) {
      const separator = segment.indexOf(":");
      const equals = segment.indexOf("=");
      const at = separator >= 0 ? separator : equals;
      if (at < 0) continue;
      const kind = decisionKind(segment.slice(0, at));
      if (!kind) continue;
      const answer = decisionAnswer(segment.slice(at + 1));
      if (answer === null) continue;
      found.push({ kind, answer, text: segment.trim() });
    }
  }
  return found;
}

export function parseOwnerDecisions(comments: Comment[] | null | undefined): OwnerDecision[] {
  const decisions: OwnerDecision[] = [];
  for (const comment of comments ?? []) {
    const body = markerBody(String(comment.body ?? ""));
    if (!body) continue;
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

export function latestDecision(
  decisions: OwnerDecision[],
  kind: "confirm" | "merge"
): OwnerDecision | null {
  const matching = decisions.filter((decision) => decision.kind === kind);
  return matching.at(-1) ?? null;
}

export function formatOwnerDecisions(decisions: OwnerDecision[]): string {
  if (!decisions.length) return "(none)";
  return decisions
    .map(
      (decision) =>
        `- ${decision.kind}: ${decision.answer ? "yes" : "no"} — ${decision.text}${decision.author ? ` (${decision.author})` : ""}`
    )
    .join("\n");
}
