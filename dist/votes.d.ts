export type VotePolicy = "off" | "agent" | "heuristic";
export declare function resolveVotePolicy(value: unknown, fallback?: VotePolicy): VotePolicy;
export declare function heuristicBidVote(detail: string): boolean;
export declare function heuristicCommentVote(detail: string): boolean;
