import path from "node:path";
export function worktreePath(profilePaths, label) {
    return path.join(profilePaths.worktreesDir, String(label));
}
export async function prepareWorktree(github, profilePaths, issue, branch) {
    const dir = worktreePath(profilePaths, issue.number);
    await github.createWorktree(branch, dir);
    return dir;
}
export async function prepareReviewWorktree(github, profilePaths, prNumber) {
    const dir = worktreePath(profilePaths, `review-${prNumber}`);
    await github.createReviewWorktree(prNumber, dir);
    return dir;
}
export async function cleanupWorktree(github, dir) {
    if (!dir)
        return;
    await github.removeWorktree(dir, true).catch(() => { });
}
//# sourceMappingURL=worktree.js.map