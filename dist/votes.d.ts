import type { VotesPolicyConfig } from "./types.js";
import type { VotePolicy } from "./types.js";
export type { VotePolicy };
export interface VoteHeuristicPolicy {
    defaultPolicy?: VotePolicy;
    bidMinChars?: number;
    bidKeywords?: string[];
    commentKeywords?: string[];
}
export declare function resolveVotePolicy(value: unknown, policy?: VoteHeuristicPolicy | VotesPolicyConfig | null | undefined): VotePolicy;
export declare function heuristicBidVote(detail: string, policy?: VoteHeuristicPolicy | VotesPolicyConfig | null | undefined): boolean;
export declare function heuristicCommentVote(detail: string, policy?: VoteHeuristicPolicy | VotesPolicyConfig | null | undefined): boolean;
