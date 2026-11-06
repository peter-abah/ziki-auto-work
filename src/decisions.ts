import type { Comment, DecisionsPolicyConfig, OwnerDecision } from "./types.js";

export interface DecisionParserPolicy {
  marker?: string;
  kinds?: string[];
  trueWords?: string[];
  falseWords?: string[];
}

function requirePolicy(policy: DecisionParserPolicy | DecisionsPolicyConfig | null | undefined): {
  marker: string;
  kinds: string[];
  trueWords: string[];
  falseWords: string[];
} {
  const marker = policy?.marker;
  const kinds = policy?.kinds;
  const trueWords = policy?.trueWords;
  const falseWords = policy?.falseWords;
  if (typeof marker !== "string" || !marker) {
    throw new Error("decisions.marker must be a non-empty string (run `auto-work migrate`)");
  }
  for (const [key, value] of [["kinds", kinds], ["trueWords", trueWords], ["falseWords", falseWords]] as const) {
    if (!Array.isArray(value) || !value.length || !value.every((entry) => typeof entry === "string")) {
      throw new Error(`decisions.${key} must be a non-empty string array (run \`auto-work migrate\`)`);
    }
  }
  return { marker, kinds: kinds as string[], trueWords: trueWords as string[], falseWords: falseWords as string[] };
}

function markerBody(body: string, marker: string): string | null {
  const index = body.indexOf(marker);
  if (index < 0) return null;
  return body.slice(index + marker.length).trim();
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

function decisionKind(key: string, kinds: string[]): string | null {
  const text = cleanKey(key).toLowerCase();
  for (const kind of kinds) {
    const lower = kind.toLowerCase();
    if (text === lower || text.startsWith(`${lower} `) || text.startsWith(`${lower}#`)) return kind;
  }
  return null;
}

function decisionAnswer(value: string, trueWords: string[], falseWords: string[]): boolean | null {
  let text = value.trim();
  while (text && "*`\"'".includes(text[0]!)) text = text.slice(1).trim();
  text = stripPunctuation(text).toLowerCase();
  if (trueWords.map((word) => word.toLowerCase()).includes(text)) return true;
  if (falseWords.map((word) => word.toLowerCase()).includes(text)) return false;
  return null;
}

function labelledDecisions(
  body: string,
  policy: { kinds: string[]; trueWords: string[]; falseWords: string[] }
): Array<{ kind: string; answer: boolean; text: string }> {
  const found: Array<{ kind: string; answer: boolean; text: string }> = [];
  for (const line of body.split(/\r?\n/)) {
    for (const segment of line.split(",")) {
      const separator = segment.indexOf(":");
      const equals = segment.indexOf("=");
      const at = separator >= 0 ? separator : equals;
      if (at < 0) continue;
      const kind = decisionKind(segment.slice(0, at), policy.kinds);
      if (!kind) continue;
      const answer = decisionAnswer(segment.slice(at + 1), policy.trueWords, policy.falseWords);
      if (answer === null) continue;
      found.push({ kind, answer, text: segment.trim() });
    }
  }
  return found;
}

export function parseOwnerDecisions(
  comments: Comment[] | null | undefined,
  policy?: DecisionParserPolicy | DecisionsPolicyConfig | null | undefined
): OwnerDecision[] {
  const resolved = requirePolicy(policy);
  const decisions: OwnerDecision[] = [];
  for (const comment of comments ?? []) {
    const body = markerBody(String(comment.body ?? ""), resolved.marker);
    if (!body) continue;
    for (const entry of labelledDecisions(body, resolved)) {
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
