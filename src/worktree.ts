import path from "node:path";
import type { Issue, ProfilePaths } from "./types.js";
import type { GitHub } from "./github.js";

export function worktreePath(profilePaths: ProfilePaths, label: string | number): string {
  return path.join(profilePaths.worktreesDir, String(label));
}

export async function prepareWorktree(
  github: GitHub,
  profilePaths: ProfilePaths,
  issue: Issue,
  branch: string
): Promise<string> {
  const dir = worktreePath(profilePaths, issue.number);
  await github.createWorktree(branch, dir);
  return dir;
}

export async function prepareReviewWorktree(github: GitHub, profilePaths: ProfilePaths, prNumber: number): Promise<string> {
  const dir = worktreePath(profilePaths, `review-${prNumber}`);
  await github.createReviewWorktree(prNumber, dir);
  return dir;
}

export async function cleanupWorktree(github: GitHub, dir: string | null | undefined): Promise<void> {
  if (!dir) return;
  await github.removeWorktree(dir, true).catch(() => {});
}
