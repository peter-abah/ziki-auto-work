import type { Comment, OwnerDecision } from "./types.js";
export declare const DECISION_MARKER = "**Decision from the owner:**";
export declare function parseOwnerDecisions(comments: Comment[] | null | undefined): OwnerDecision[];
export declare function latestDecision(decisions: OwnerDecision[], kind: "confirm" | "merge"): OwnerDecision | null;
export declare function formatOwnerDecisions(decisions: OwnerDecision[]): string;
