import test from "node:test";
import assert from "node:assert/strict";
import { buildQueue, knownKinds, queueSets } from "./queue.js";
import { DEFAULT_LIMITS, DEFAULT_WORKFLOW } from "./config.js";
import { loadInitTemplates } from "./config-templates.js";
const templates = await loadInitTemplates();
const templateQueue = templates.queue;
const KINDS = [
    "owner_request",
    "offer",
    "review_offer",
    "job_review_offer",
    "active_claim",
    "ready_issue",
    "open_issue",
    "reclaim_issue",
    "test_fix",
    "accept_fix",
    "review_idle",
    "deliver_stranded",
    "merge_fix",
    "reconcile_merged",
    "idea",
    "convert_idea",
    "reject_idea",
    "confirm_issue",
    "close_issue",
    "sense_check",
    "vote_importance",
    "estimate_reward",
    "investigate_issue",
    "review_comment",
    "refresh_stake",
    "vote_stake",
    "report_pr_status",
    "report_deployment",
    "repair_pull_request",
    "await_release",
    "research_job",
    "award_bid",
    "review_bid",
    "categorize"
];
const NO_ISSUE = new Set(["owner_request", "review_offer", "job_review_offer", "research_job", "refresh_stake", "vote_stake", "categorize"]);
function profile() {
    return {
        ziki: { baseUrl: "https://ziki.dev", projectId: "p", projectSlug: "demo", platform: "desktop" },
        repo: { url: "", upstream: "", base: "staging", githubRepo: "o/r", forkOwner: "f", defaultBranch: "main" },
        agents: { workers: [], managers: [] },
        executor: { provider: "opencode" },
        toolchain: {},
        checks: [],
        platformMatch: { keywords: ["demo"] },
        prompts: { dir: "prompts/generic" },
        pr: { templateFile: "prompts/generic/pr.md" },
        discovery: { enabled: false },
        workflow: { ...DEFAULT_WORKFLOW },
        limits: { ...DEFAULT_LIMITS },
        pollSeconds: 120,
        memoryRefreshMinutes: 30,
        hitl: { enabled: true, defaultType: "question" },
        queue: JSON.parse(JSON.stringify(templateQueue))
    };
}
test("template queue covers every known kind and bucket", () => {
    const sets = queueSets(profile());
    for (const kind of KINDS) {
        assert.ok(sets.known.has(kind), `${kind} missing from template queue buckets`);
        assert.ok(typeof sets.priorities[kind] === "number", `${kind} missing a priority`);
    }
    assert.equal(knownKinds(profile()).size, KINDS.length);
});
test("every latest Ziki work kind is known and queued", () => {
    const items = KINDS.map((kind, index) => {
        const issue = NO_ISSUE.has(kind)
            ? undefined
            : { id: `issue_${index}`, number: 1000 + index, title: `demo ${kind}`, url: `https://ziki.dev/demo/${1000 + index}` };
        return {
            kind,
            key: `${kind}:${index}`,
            title: `demo ${kind}`,
            detail: "demo work",
            minimumRole: "working",
            canAct: true,
            issue,
            actions: [{ name: kind, minimumRole: "working", method: "POST", path: `/api/v1/${kind}/${index}` }]
        };
    });
    const feed = {
        project: { id: "p", slug: "demo", name: "Demo" },
        agent: { id: "a", name: "agent", level: "working" },
        workUrl: "https://ziki.dev/demo/work",
        pollAfterSeconds: 30,
        ask: [],
        inbox: { unread: 0, path: "/api/v1/inbox" },
        counts: {},
        waiting: [],
        items
    };
    const queue = buildQueue({
        feed,
        profile: profile(),
        platformNumbers: new Set(items.map((item) => item.issue?.number).filter((value) => value !== undefined)),
        platformIdeaNumbers: new Set()
    });
    assert.equal(queue.all.length, KINDS.length);
    for (const kind of KINDS) {
        assert.equal(queue.counts[kind], 1, `${kind} missing from queue counts`);
    }
    assert.equal(queue.other.length, 0);
});
test("unknown kinds sort last in the other bucket instead of being dropped", () => {
    const feed = {
        project: { id: "p", slug: "demo", name: "Demo" },
        agent: { id: "a", name: "a", level: "working" },
        workUrl: "https://ziki.dev/demo/work",
        pollAfterSeconds: 30,
        ask: [],
        inbox: { unread: 0, path: "/api/v1/inbox" },
        counts: {},
        waiting: [],
        items: [
            {
                kind: "brand_new_kind",
                key: "brand_new_kind:1",
                title: "demo",
                detail: "demo",
                minimumRole: "working",
                canAct: true,
                actions: []
            }
        ]
    };
    const queue = buildQueue({ feed, profile: profile() });
    assert.equal(queue.all.length, 1);
    assert.equal(queue.other.length, 1);
    assert.equal(queue.other[0].kind, "brand_new_kind");
    const maxKnown = Math.max(...Object.values(templateQueue.priorities));
    assert.equal(queue.other[0].priority, maxKnown + 1);
});
test("canAct false work is not dispatched", () => {
    const feed = {
        project: { id: "p", slug: "demo", name: "Demo" },
        agent: { id: "a", name: "agent", level: "working" },
        workUrl: "https://ziki.dev/demo/work",
        pollAfterSeconds: 30,
        ask: [],
        inbox: { unread: 0, path: "/api/v1/inbox" },
        counts: {},
        waiting: [{ kind: "merge_fix", count: 1, minimumRole: "merger", what: "merge it" }],
        items: [
            {
                kind: "merge_fix",
                key: "merge_fix:1",
                title: "demo",
                detail: "demo",
                minimumRole: "merger",
                canAct: false,
                actions: []
            }
        ]
    };
    const queue = buildQueue({ feed, profile: profile() });
    assert.equal(queue.all.length, 0);
});
test("queue without policy fails loud", () => {
    const { queue: _dropped, ...rest } = profile();
    assert.throws(() => queueSets(rest), /profile.queue is required/);
});
//# sourceMappingURL=queue.test.js.map