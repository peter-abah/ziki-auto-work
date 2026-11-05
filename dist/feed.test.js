import test from "node:test";
import assert from "node:assert/strict";
import { mergeWorkItemFeeds } from "./feed.js";
function feed(items) {
    return {
        project: { id: "p", slug: "demo", name: "Demo" },
        agent: { id: "a", name: "agent", level: "working" },
        workUrl: "https://ziki.test/demo/work",
        pollAfterSeconds: 30,
        ask: [],
        inbox: { unread: 0, path: "/api/v1/inbox" },
        counts: {},
        waiting: [],
        items
    };
}
function item(key, kind = "ready_issue", actions = 1) {
    return {
        key,
        kind,
        title: `${kind} ${key}`,
        detail: "detail",
        minimumRole: "working",
        canAct: true,
        actions: Array.from({ length: actions }, (_, index) => ({
            name: "action",
            minimumRole: "working",
            method: "POST",
            path: `/api/v1/${key}/${index}`
        }))
    };
}
test("merges every agent feed and keeps agent-specific items", () => {
    const merged = mergeWorkItemFeeds([
        { agent: "Stilgar", feed: feed([item("ready:1"), item("claim:stilgar", "active_claim")]) },
        { agent: "Muadib", feed: feed([item("offer:1432", "offer"), item("claim:muadib", "active_claim")]) },
        { agent: "Duncan", feed: feed([item("merge:5", "merge_fix")]) }
    ]);
    assert.deepEqual(merged.agents, ["Stilgar", "Muadib", "Duncan"]);
    assert.equal(merged.items.length, 5);
    assert.equal(merged.counts.Muadib, 2);
    assert.equal(merged.items.find((entry) => entry.key === "offer:1432")?._feedAgent, "Muadib");
    assert.equal(merged.items.find((entry) => entry.key === "merge:5")?._feedAgent, "Duncan");
});
test("prefers the copy with more actions for a shared key", () => {
    const merged = mergeWorkItemFeeds([
        { agent: "Stilgar", feed: feed([item("shared", "test_fix", 1)]) },
        { agent: "Duncan", feed: feed([item("shared", "test_fix", 3)]) }
    ]);
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0].actions.length, 3);
    assert.equal(merged.items[0]._feedAgent, "Duncan");
});
//# sourceMappingURL=feed.test.js.map