export type VotePolicy = "off" | "agent" | "heuristic";

export function resolveVotePolicy(value: unknown, fallback: VotePolicy = "agent"): VotePolicy {
  return value === "off" || value === "agent" || value === "heuristic" ? value : fallback;
}

export function heuristicBidVote(detail: string): boolean {
  const text = (detail ?? "").toLowerCase();
  if (text.length < 40) return false;
  return ["fix", "implement", "add", "update", "test", "change"].some((word) => text.includes(word));
}

export function heuristicCommentVote(detail: string): boolean {
  const text = (detail ?? "").toLowerCase();
  return text.includes("root cause") || text.includes("reproduction") || text.includes("file:") || text.includes(".dart:");
}
