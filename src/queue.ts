import type { JobConfig, Queue, QueueEntry, State, WorkFeed, WorkItem } from "./types.js";

const PRIORITY: Record<string, number> = {
  owner_request: 1,
  offer: 2,
  active_claim: 2,
  ready_issue: 3,
  test_fix: 4,
  accept_fix: 5,
  confirm_issue: 6,
  idea: 7,
  award_bid: 8,
  review_bid: 9,
  review_comment: 10,
  report_pr_status: 11,
  categorize: 12,
  investigate_issue: 13,
  report_deployment: 14,
  estimate_reward: 15,
  close_issue: 16,
  reject_idea: 17
};

const AUX_KINDS = new Set([
  "idea",
  "confirm_issue",
  "review_bid",
  "award_bid",
  "review_comment",
  "report_pr_status",
  "categorize",
  "investigate_issue",
  "report_deployment",
  "estimate_reward",
  "close_issue",
  "reject_idea"
]);

const REVIEW_KINDS = new Set(["test_fix", "accept_fix"]);
const WORK_KINDS = new Set(["ready_issue", "active_claim", "offer"]);

export function textMatchesPlatform(job: JobConfig, text: string): boolean {
  if (job.platformMatch.regex) {
    try {
      return new RegExp(job.platformMatch.regex, "i").test(text);
    } catch {
      return false;
    }
  }
  const keywords = job.platformMatch.keywords ?? [];
  if (!keywords.length) return false;
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export function matchesPlatform(job: JobConfig, item: WorkItem): boolean {
  const text = `${item.title ?? ""} ${item.detail ?? ""} ${item.issue?.title ?? ""} ${item.idea?.title ?? ""}`;
  return textMatchesPlatform(job, text);
}

export function buildQueue(options: {
  feed: WorkFeed;
  job: JobConfig;
  platformNumbers?: Set<number>;
  platformIdeaNumbers?: Set<number>;
  state?: State | null;
  now?: number;
  recentMs?: number;
}): Queue {
  const { feed, job } = options;
  const platformNumbers = options.platformNumbers ?? new Set<number>();
  const platformIdeaNumbers = options.platformIdeaNumbers ?? new Set<number>();
  const now = options.now ?? Date.now();
  const recentMs = options.recentMs ?? 30 * 60 * 1000;
  const recent = options.state?.recentFeedKeys ?? {};
  const tasks = options.state?.tasks ?? {};
  const queue: QueueEntry[] = [];
  const seen = new Set<string>();

  for (const item of feed.items ?? []) {
    if (!item?.canAct) continue;
    if (seen.has(item.key)) continue;
    seen.add(item.key);

    const kind = item.kind;
    const issueNumber = item.issue?.number ?? null;
    const ideaNumber = item.idea?.number ?? null;
    const issueId = item.issue?.id ?? null;
    const ideaId = item.idea?.id ?? null;
    const task = issueId ? tasks[issueId] : null;

    const blocked = ["done", "failed", "skipped", "waiting_human", "delivered"];
    if (kind !== "active_claim") blocked.push("working", "claimed");
    if (task && blocked.includes(task.status)) continue;
    if (recent[item.key] && now - recent[item.key]! < recentMs) continue;

    let isPlatform = false;
    if (kind === "owner_request" || kind === "categorize") {
      isPlatform = true;
    } else if (issueNumber !== null) {
      isPlatform = platformNumbers.has(issueNumber) || matchesPlatform(job, item);
    } else if (ideaNumber !== null) {
      isPlatform = platformIdeaNumbers.has(ideaNumber) || matchesPlatform(job, item);
    } else {
      isPlatform = matchesPlatform(job, item);
    }
    if (!isPlatform) continue;

    const priority = PRIORITY[kind] ?? 50;
    const entry: QueueEntry = {
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
    if (kind === "owner_request") entry.bucket = "owner";
    else if (WORK_KINDS.has(kind)) entry.bucket = "work";
    else if (REVIEW_KINDS.has(kind)) entry.bucket = "review";
    else if (AUX_KINDS.has(kind)) entry.bucket = "aux";

    queue.push(entry);
  }

  queue.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aDue = a.item.dueAt ? new Date(a.item.dueAt).getTime() : 0;
    const bDue = b.item.dueAt ? new Date(b.item.dueAt).getTime() : 0;
    return aDue - bDue;
  });

  const counts = queue.reduce<Record<string, number>>((acc, entry) => {
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

export function actionFor(item: WorkItem, name: string) {
  return (item.actions ?? []).find((action) => action.name === name) ?? null;
}

export function itemPath(item: WorkItem, name: string): string | null {
  return actionFor(item, name)?.path ?? null;
}
