import type { Comment, DecisionsPolicyConfig, OwnerDecision } from "./types.js";
export interface DecisionParserPolicy {
    marker?: string;
    kinds?: string[];
    trueWords?: string[];
    falseWords?: string[];
}
export declare function parseOwnerDecisions(comments: Comment[] | null | undefined, policy?: DecisionParserPolicy | DecisionsPolicyConfig | null | undefined): OwnerDecision[];
export declare function latestDecision(decisions: OwnerDecision[], kind: "confirm" | "merge"): OwnerDecision | null;
export declare function formatOwnerDecisions(decisions: OwnerDecision[]): string;
