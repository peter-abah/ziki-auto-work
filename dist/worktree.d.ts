import type { Issue, ProfilePaths } from "./types.js";
import type { GitHub } from "./github.js";
export declare function worktreePath(profilePaths: ProfilePaths, label: string | number): string;
export declare function prepareWorktree(github: GitHub, profilePaths: ProfilePaths, issue: Issue, branch: string): Promise<string>;
export declare function prepareReviewWorktree(github: GitHub, profilePaths: ProfilePaths, prNumber: number): Promise<string>;
export declare function cleanupWorktree(github: GitHub, dir: string | null | undefined): Promise<void>;
