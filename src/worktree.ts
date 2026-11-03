import path from "node:path";
import type { Issue, JobPaths } from "./types.js";
import type { GitHub } from "./github.js";

export function worktreePath(jobPaths: JobPaths, label: string | number): string {
  return path.join(jobPaths.worktreesDir, String(label));
}

export async function prepareWorktree(
  github: GitHub,
  jobPaths: JobPaths,
  issue: Issue,
  branch: string
): Promise<string> {
  const dir = worktreePath(jobPaths, issue.number);
  await github.createWorktree(branch, dir);
  return dir;
}

export async function prepareReviewWorktree(github: GitHub, jobPaths: JobPaths, prNumber: number): Promise<string> {
  const dir = worktreePath(jobPaths, `review-${prNumber}`);
  await github.createReviewWorktree(prNumber, dir);
  return dir;
}

export async function cleanupWorktree(github: GitHub, dir: string | null | undefined): Promise<void> {
  if (!dir) return;
  await github.removeWorktree(dir, true).catch(() => {});
}
