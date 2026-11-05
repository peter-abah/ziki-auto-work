import type { WorkFeed, WorkItem } from "./types.js";
export interface AgentFeed {
    agent: string;
    feed: WorkFeed;
}
export interface MergedFeed {
    base: WorkFeed | null;
    items: WorkItem[];
    agents: string[];
    counts: Record<string, number>;
}
export declare function mergeWorkItemFeeds(feeds: AgentFeed[]): MergedFeed;
