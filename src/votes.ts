import type { VotesPolicyConfig } from "./types.js";
import type { VotePolicy } from "./types.js";

export type { VotePolicy };

export interface VoteHeuristicPolicy {
  defaultPolicy?: VotePolicy;
  bidMinChars?: number;
  bidKeywords?: string[];
  commentKeywords?: string[];
}

function requirePolicy(policy: VoteHeuristicPolicy | VotesPolicyConfig | null | undefined): {
  defaultPolicy: VotePolicy;
  bidMinChars: number;
  bidKeywords: string[];
  commentKeywords: string[];
} {
  const fallback = policy?.defaultPolicy;
  const defaultPolicy: VotePolicy =
    fallback === "off" || fallback === "agent" || fallback === "heuristic" ? fallback : "agent";
  const bidMinChars = policy?.bidMinChars;
  const bidKeywords = policy?.bidKeywords;
  const commentKeywords = policy?.commentKeywords;
  if (typeof bidMinChars !== "number" || !Number.isFinite(bidMinChars) || bidMinChars < 0) {
    throw new Error("votes.bidMinChars must be a non-negative number (run `auto-work migrate`)");
  }
  for (const [key, value] of [["bidKeywords", bidKeywords], ["commentKeywords", commentKeywords]] as const) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      throw new Error(`votes.${key} must be an array of strings (run \`auto-work migrate\`)`);
    }
  }
  return { defaultPolicy, bidMinChars, bidKeywords: bidKeywords as string[], commentKeywords: commentKeywords as string[] };
}

export function resolveVotePolicy(
  value: unknown,
  policy?: VoteHeuristicPolicy | VotesPolicyConfig | null | undefined
): VotePolicy {
  if (value === "off" || value === "agent" || value === "heuristic") return value;
  const fallback = policy?.defaultPolicy;
  if (fallback === "off" || fallback === "agent" || fallback === "heuristic") return fallback;
  return "agent";
}

export function heuristicBidVote(
  detail: string,
  policy?: VoteHeuristicPolicy | VotesPolicyConfig | null | undefined
): boolean {
  const resolved = requirePolicy(policy);
  const text = (detail ?? "").toLowerCase();
  if (text.length < resolved.bidMinChars) return false;
  return resolved.bidKeywords.some((word) => text.includes(word.toLowerCase()));
}

export function heuristicCommentVote(
  detail: string,
  policy?: VoteHeuristicPolicy | VotesPolicyConfig | null | undefined
): boolean {
  const resolved = requirePolicy(policy);
  const text = (detail ?? "").toLowerCase();
  return resolved.commentKeywords.some((word) => text.includes(word.toLowerCase()));
}
