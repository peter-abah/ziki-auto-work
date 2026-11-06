function requireArray(value, path) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        throw new Error(`${path} must be an array of strings (run \`auto-work migrate\`)`);
    }
    return value;
}
/**
 * Queue policy from config — no built-in buckets, priorities or gates.
 * Unknown kinds sort after every known kind (derived max+1, not a literal)
 * and land in the "other" bucket where the unknown-vocabulary warning
 * surfaces them instead of dropping them.
 */
export function queueSets(profile) {
    const policy = profile.queue;
    if (!policy || typeof policy !== "object") {
        throw new Error("profile.queue is required (run `auto-work migrate`)");
    }
    if (!policy.priorities || typeof policy.priorities !== "object") {
        throw new Error("profile.queue.priorities is required (run `auto-work migrate`)");
    }
    const buckets = policy.buckets;
    if (!buckets || typeof buckets !== "object") {
        throw new Error("profile.queue.buckets is required (run `auto-work migrate`)");
    }
    const owner = new Set(requireArray(buckets.owner, "profile.queue.buckets.owner"));
    const work = new Set(requireArray(buckets.work, "profile.queue.buckets.work"));
    const review = new Set(requireArray(buckets.review, "profile.queue.buckets.review"));
    const aux = new Set(requireArray(buckets.aux, "profile.queue.buckets.aux"));
    const known = new Set([...owner, ...work, ...review, ...aux]);
    const values = Object.values(policy.priorities);
    const unknownPriority = values.length ? Math.max(...values) + 1 : 0;
    return {
        priorities: policy.priorities,
        owner,
        work,
        review,
        aux,
        known,
        noIssue: new Set(requireArray(policy.noIssueKinds, "profile.queue.noIssueKinds")),
        blockedStatuses: requireArray(policy.blockedStatuses, "profile.queue.blockedStatuses"),
        activeStatuses: requireArray(policy.activeStatuses, "profile.queue.activeStatuses"),
        recentMs: typeof policy.recentMs === "number" && Number.isFinite(policy.recentMs) && policy.recentMs >= 0
            ? policy.recentMs
            : (() => {
                throw new Error("profile.queue.recentMs must be a non-negative number (run `auto-work migrate`)");
            })(),
        unknownPriority
    };
}
/** Known feed kinds from the active profile's queue buckets (for tests/drift checks). */
export function knownKinds(profile) {
    return queueSets(profile).known;
}
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
    const sets = queueSets(profile);
    const platformNumbers = options.platformNumbers ?? new Set();
    const platformIdeaNumbers = options.platformIdeaNumbers ?? new Set();
    const now = options.now ?? Date.now();
    const recentMs = sets.recentMs;
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
        const blocked = [...sets.blockedStatuses];
        if (kind !== "active_claim")
            blocked.push(...sets.activeStatuses);
        if (task && blocked.includes(task.status))
            continue;
        if (recent[item.key] && now - recent[item.key] < recentMs)
            continue;
        let isPlatform = false;
        if (sets.noIssue.has(kind)) {
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
        const priority = sets.priorities[kind] ?? sets.unknownPriority;
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
        if (sets.owner.has(kind))
            entry.bucket = "owner";
        else if (sets.work.has(kind))
            entry.bucket = "work";
        else if (sets.review.has(kind))
            entry.bucket = "review";
        else if (sets.aux.has(kind))
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