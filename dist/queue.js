const PRIORITY = {
    owner_request: 1,
    offer: 2,
    review_offer: 3,
    job_review_offer: 3,
    active_claim: 4,
    reclaim_issue: 5,
    ready_issue: 6,
    open_issue: 7,
    test_fix: 8,
    deliver_stranded: 9,
    accept_fix: 10,
    merge_fix: 11,
    reconcile_merged: 12,
    await_release: 13,
    convert_idea: 14,
    reject_idea: 15,
    confirm_issue: 16,
    idea: 17,
    vote_importance: 18,
    sense_check: 19,
    close_issue: 20,
    review_idle: 21,
    estimate_reward: 22,
    investigate_issue: 23,
    vote_stake: 24,
    refresh_stake: 25,
    review_comment: 26,
    report_pr_status: 27,
    report_deployment: 28,
    repair_pull_request: 29,
    research_job: 30,
    award_bid: 31,
    review_bid: 32,
    categorize: 33
};
export const OWNER_KINDS = new Set(["owner_request"]);
export const WORK_KINDS = new Set([
    "offer",
    "review_offer",
    "job_review_offer",
    "active_claim",
    "ready_issue",
    "open_issue",
    "reclaim_issue"
]);
export const REVIEW_KINDS = new Set([
    "test_fix",
    "accept_fix",
    "review_idle",
    "deliver_stranded",
    "merge_fix",
    "reconcile_merged"
]);
export const AUX_KINDS = new Set([
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
]);
const NO_ISSUE_KINDS = new Set([
    "owner_request",
    "categorize",
    "research_job",
    "job_review_offer",
    "refresh_stake",
    "vote_stake"
]);
export const KNOWN_KINDS = new Set([
    ...OWNER_KINDS,
    ...WORK_KINDS,
    ...REVIEW_KINDS,
    ...AUX_KINDS
]);
export function textMatchesPlatform(profile, text) {
    if (profile.platformMatch.regex) {
        try {
            return new RegExp(profile.platformMatch.regex, "i").test(text);
        }
        catch {
            return false;
        }
    }
    const keywords = profile.platformMatch.keywords ?? [];
    if (!keywords.length)
        return false;
    const lower = text.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}
export function matchesPlatform(profile, item) {
    const text = `${item.title ?? ""} ${item.detail ?? ""} ${item.issue?.title ?? ""} ${item.idea?.title ?? ""}`;
    return textMatchesPlatform(profile, text);
}
export function buildQueue(options) {
    const { feed, profile } = options;
    const platformNumbers = options.platformNumbers ?? new Set();
    const platformIdeaNumbers = options.platformIdeaNumbers ?? new Set();
    const now = options.now ?? Date.now();
    const recentMs = options.recentMs ?? 30 * 60 * 1000;
    const recent = options.state?.recentFeedKeys ?? {};
    const tasks = options.state?.tasks ?? {};
    const queue = [];
    const seen = new Set();
    for (const item of feed.items ?? []) {
        if (!item?.canAct)
            continue;
        if (seen.has(item.key))
            continue;
        seen.add(item.key);
        const kind = item.kind;
        const issueNumber = item.issue?.number ?? null;
        const ideaNumber = item.idea?.number ?? null;
        const issueId = item.issue?.id ?? null;
        const ideaId = item.idea?.id ?? null;
        const task = issueId ? tasks[issueId] : null;
        const blocked = ["done", "failed", "skipped", "waiting_human", "delivered"];
        if (kind !== "active_claim")
            blocked.push("working", "claimed");
        if (task && blocked.includes(task.status))
            continue;
        if (recent[item.key] && now - recent[item.key] < recentMs)
            continue;
        let isPlatform = false;
        if (NO_ISSUE_KINDS.has(kind)) {
            isPlatform = true;
        }
        else if (kind === "categorize") {
            isPlatform = true;
        }
        else if (issueNumber !== null) {
            isPlatform = platformNumbers.has(issueNumber) || matchesPlatform(profile, item);
        }
        else if (ideaNumber !== null) {
            isPlatform = platformIdeaNumbers.has(ideaNumber) || matchesPlatform(profile, item);
        }
        else {
            isPlatform = matchesPlatform(profile, item);
        }
        if (!isPlatform)
            continue;
        const priority = PRIORITY[kind] ?? 50;
        const entry = {
            key: item.key,
            kind,
            priority,
            item,
            issueId,
            issueNumber,
            ideaId,
            ideaNumber,
            title: item.title,
            detail: item.detail,
            actions: item.actions ?? [],
            bucket: "other"
        };
        if (OWNER_KINDS.has(kind))
            entry.bucket = "owner";
        else if (WORK_KINDS.has(kind))
            entry.bucket = "work";
        else if (REVIEW_KINDS.has(kind))
            entry.bucket = "review";
        else if (AUX_KINDS.has(kind))
            entry.bucket = "aux";
        queue.push(entry);
    }
    queue.sort((a, b) => {
        if (a.priority !== b.priority)
            return a.priority - b.priority;
        const aDue = a.item.dueAt ? new Date(a.item.dueAt).getTime() : 0;
        const bDue = b.item.dueAt ? new Date(b.item.dueAt).getTime() : 0;
        return aDue - bDue;
    });
    const counts = queue.reduce((acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
        return acc;
    }, {});
    return {
        all: queue,
        owner: queue.filter((entry) => entry.bucket === "owner"),
        work: queue.filter((entry) => entry.bucket === "work"),
        review: queue.filter((entry) => entry.bucket === "review"),
        aux: queue.filter((entry) => entry.bucket === "aux"),
        other: queue.filter((entry) => entry.bucket === "other"),
        counts
    };
}
export function actionFor(item, name) {
    return (item.actions ?? []).find((action) => action.name === name) ?? null;
}
export function itemPath(item, name) {
    return actionFor(item, name)?.path ?? null;
}
//# sourceMappingURL=queue.js.map