import type { ProfileConfig, Queue, State, WorkFeed, WorkItem } from "./types.js";
export declare function textMatchesPlatform(profile: ProfileConfig, text: string): boolean;
export declare function matchesPlatform(profile: ProfileConfig, item: WorkItem): boolean;
export declare function buildQueue(options: {
    feed: WorkFeed;
    profile: ProfileConfig;
    platformNumbers?: Set<number>;
    platformIdeaNumbers?: Set<number>;
    state?: State | null;
    now?: number;
    recentMs?: number;
}): Queue;
export declare function actionFor(item: WorkItem, name: string): import("./types.js").WorkAction | null;
export declare function itemPath(item: WorkItem, name: string): string | null;
