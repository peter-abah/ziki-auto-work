import type { PrComment } from "./github.js";

export interface PrCommentPolicy {
  mentions: string[];
}

function isBot(author: string): boolean {
  return author.trim().toLowerCase().endsWith("[bot]");
}

function mentions(body: string, names: string[]): boolean {
  const lower = body.toLowerCase();
  return names.some((name) => name && lower.includes(`@${name.toLowerCase()}`));
}

function startsWithCommand(body: string): boolean {
  const first = body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first === "/fix" || first === "!fix" || first === "@auto-work";
}

export function isActionablePrComment(comment: PrComment, policy: PrCommentPolicy): boolean {
  const body = comment.body.trim();
  if (!body) return false;
  if (isBot(comment.author)) return false;
  if (comment.kind === "review" && (comment.path || comment.line)) return true;
  if (startsWithCommand(body)) return true;
  return mentions(body, policy.mentions);
}

export function actionablePrComments(
  comments: PrComment[],
  handledAt: string | null | undefined,
  policy: PrCommentPolicy
): PrComment[] {
  const cutoff = handledAt ? Date.parse(handledAt) : 0;
  return comments.filter((comment) => {
    if (!isActionablePrComment(comment, policy)) return false;
    const at = Date.parse(comment.createdAt ?? "") || 0;
    return at > (Number.isFinite(cutoff) ? cutoff : 0);
  });
}
