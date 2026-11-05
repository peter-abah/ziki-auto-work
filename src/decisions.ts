import type { Comment, OwnerDecision } from "./types.js";

export const DECISION_MARKER = "**Decision from the owner:**";

function markerBody(body: string): string | null {
  const index = body.indexOf(DECISION_MARKER);
  if (index < 0) return null;
  return body.slice(index + DECISION_MARKER.length).trim();
}

function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function answerFor(text: string, kind: "confirm" | "merge"): boolean | null {
  const lower = text.toLowerCase();
  if (!lower.includes(kind)) return null;
  if (/\b(do not|don't|dont|not|no|reject|decline|deny|cancel|stop)\b/.test(lower)) return false;
  if (/\b(yes|yeah|yep|approve|approved|confirm|merge|proceed|go ahead|do it|accept)\b/.test(lower)) return true;
  return null;
}

export function parseOwnerDecisions(comments: Comment[] | null | undefined): OwnerDecision[] {
  const decisions: OwnerDecision[] = [];
  for (const comment of comments ?? []) {
    const body = markerBody(String(comment.body ?? ""));
    if (!body) continue;
    const parts = sentences(body);
    const found = new Map<"confirm" | "merge", boolean>();
    for (const sentence of parts) {
      for (const kind of ["confirm", "merge"] as const) {
        if (found.has(kind)) continue;
        const answer = answerFor(sentence, kind);
        if (answer === null) continue;
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
