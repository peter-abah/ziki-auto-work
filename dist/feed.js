export function mergeWorkItemFeeds(feeds) {
    const merged = new Map();
    const counts = {};
    let base = null;
    for (const { agent, feed } of feeds) {
        if (!base)
            base = feed;
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
//# sourceMappingURL=feed.js.map