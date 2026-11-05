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

export function mergeWorkItemFeeds(feeds: AgentFeed[]): MergedFeed {
  const merged = new Map<string, WorkItem>();
  const counts: Record<string, number> = {};
  let base: WorkFeed | null = null;

  for (const { agent, feed } of feeds) {
    if (!base) base = feed;
    counts[agent] = feed.items?.length ?? 0;
    for (const item of feed.items ?? []) {
      const copy = { ...item, _feedAgent: agent };
      const previous = merged.get(copy.key);
      if (!previous || (copy.actions?.length ?? 0) > (previous.actions?.length ?? 0)) {
        merged.set(copy.key, copy);
      }
    }
  }

  return { base, items: [...merged.values()], agents: feeds.map((entry) => entry.agent), counts };
}
