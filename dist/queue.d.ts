import type { ProfileConfig, Queue, State, WorkFeed, WorkItem } from "./types.js";
export interface QueueSets {
    priorities: Record<string, number>;
    owner: Set<string>;
    work: Set<string>;
    review: Set<string>;
    aux: Set<string>;
    known: Set<string>;
    noIssue: Set<string>;
    blockedStatuses: string[];
    activeStatuses: string[];
    recentMs: number;
    unknownPriority: number;
}
/**
 * Queue policy from config — no built-in buckets, priorities or gates.
 * Unknown kinds sort after every known kind (derived max+1, not a literal)
 * and land in the "other" bucket where the unknown-vocabulary warning
 * surfaces them instead of dropping them.
 */
export declare function queueSets(profile: ProfileConfig): QueueSets;
/** Known feed kinds from the active profile's queue buckets (for tests/drift checks). */
export declare function knownKinds(profile: ProfileConfig): Set<string>;
export declare function textMatchesPlatform(profile: ProfileConfig, text: string): boolean;
export declare function matchesPlatform(profile: ProfileConfig, item: WorkItem): boolean;
export declare function buildQueue(options: {
    feed: WorkFeed;
    profile: ProfileConfig;
    platformNumbers?: Set<number>;
    platformIdeaNumbers?: Set<number>;
    state?: State | null;
    now?: number;
}): Queue;
export declare function actionFor(item: WorkItem, name: string): import("./types.js").WorkAction | null;
export declare function itemPath(item: WorkItem, name: string): string | null;
