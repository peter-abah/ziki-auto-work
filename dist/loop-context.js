import { formatOwnerDecisions } from "./decisions.js";
function line(label, value) {
    if (value === undefined || value === null || value === "")
        return `${label}: (none)`;
    if (Array.isArray(value))
        return `${label}: ${value.length ? value.join(", ") : "(none)"}`;
    return `${label}: ${String(value)}`;
}
export function formatLoopContext(input) {
    const blocks = [];
    if (input.issue) {
        const issue = input.issue;
        blocks.push([
            "### Ziki issue",
            line("Number", `#${issue.number}`),
            line("Title", issue.title),
            line("Status", `${issue.status}/${issue.substatus}`),
            line("Holder", issue.holder ? `${issue.holder.agentName} (${issue.holder.status})` : null),
            line("Reward", issue.reward ? `$${issue.reward.reward} (${issue.reward.estimates}/${issue.reward.maxEstimates})` : null),
            line("Pull request", issue.pullRequestUrl),
            line("Summary", issue.summary),
            line("Description", issue.description)
        ].join("\n"));
        const comments = (issue.comments ?? [])
            .slice(-20)
            .map((comment) => `- ${comment.authorName ?? comment.by ?? "someone"}: ${comment.body}`)
            .join("\n");
        if (comments)
            blocks.push(`### Ziki comments (newest last)\n${comments}`);
    }
    if (input.idea) {
        blocks.push([
            "### Ziki idea",
            line("Number", `#${input.idea.number}`),
            line("Title", input.idea.title),
            line("Status", input.idea.status),
            line("Score", input.idea.score),
            line("Summary", input.idea.summary),
            line("Description", input.idea.description)
        ].join("\n"));
    }
    if (input.task) {
        blocks.push([
            "### Task",
            line("Attempt", input.task.attempts),
            line("Status", input.task.status),
            line("Prior error", input.task.lastError),
            line("Follow-up attempts", input.task.followUpAttempts ?? 0),
            line("Tokens", input.task.tokens?.total)
        ].join("\n"));
    }
    if (input.pr) {
        const pr = input.pr;
        blocks.push([
            "### Pull request",
            line("URL", pr.url),
            line("State", pr.state),
            line("Merged", pr.merged ? `yes${pr.mergedInto ? ` into ${pr.mergedInto}` : ""}` : "no"),
            line("Head", pr.headSha),
            line("Base", pr.baseRefName),
            line("Checks", pr.checks),
            line("Mergeable", pr.mergeable),
            line("Review decision", pr.reviewDecision),
            line("Draft", pr.isDraft)
        ].join("\n"));
        if (pr.reviews.length) {
            blocks.push(`### Reviews\n${pr.reviews
                .map((review) => `- ${review.author}: ${review.state}${review.body ? ` — ${review.body}` : ""}`)
                .join("\n")}`);
        }
        if (input.reviewComments?.length) {
            blocks.push(`### Review comments\n${input.reviewComments
                .map((comment) => `- ${comment.author}${comment.path ? ` (${comment.path})` : ""}: ${comment.body}`)
                .join("\n")}`);
        }
        if (input.checkLogs?.length) {
            blocks.push(`### Failed check logs\n${input.checkLogs
                .map((entry) => `#### ${entry.name}\n${entry.log}`)
                .join("\n\n")}`);
        }
    }
    if (input.git) {
        const git = input.git;
        blocks.push([
            "### Git",
            line("Branch", git.branch),
            line("Base", git.base),
            line("Base SHA", git.baseSha),
            line("Head SHA", git.headSha),
            line("Ahead", git.ahead),
            line("Behind", git.behind),
            line("Conflicts", git.conflicts ? "yes" : "no"),
            line("Diff stats", git.diff ? `${git.diff.files} files, +${git.diff.insertions}/-${git.diff.deletions}` : null),
            line("Changed files", git.files)
        ].join("\n"));
    }
    if (input.ownerDecisions?.length) {
        blocks.push(`### Your Call decisions\n${formatOwnerDecisions(input.ownerDecisions)}`);
    }
    if (input.workflow) {
        blocks.push(`### Workflow policy\n${Object.entries(input.workflow)
            .map(([key, value]) => line(key, value))
            .join("\n")}`);
    }
    if (input.budgets) {
        blocks.push(`### Budgets\n${Object.entries(input.budgets)
            .map(([key, value]) => line(key, value))
            .join("\n")}`);
    }
    if (input.available?.length)
        blocks.push(`### Available work\n${input.available.map((item) => `- ${item}`).join("\n")}`);
    if (input.blocked?.length)
        blocks.push(`### Blocked or skipped\n${input.blocked.map((item) => `- ${item}`).join("\n")}`);
    if (input.changedSinceLastLoop)
        blocks.push(`### What changed since the last loop\n${input.changedSinceLastLoop}`);
    return blocks.length ? blocks.join("\n\n") : "(no loop context available)";
}
//# sourceMappingURL=loop-context.js.map