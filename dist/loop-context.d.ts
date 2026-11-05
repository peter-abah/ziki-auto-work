import type { GitHubPrStatus, PrComment } from "./github.js";
import type { Idea, Issue, OwnerDecision, TaskState } from "./types.js";
export interface LoopGitContext {
    branch?: string | null;
    base?: string | null;
    baseSha?: string | null;
    headSha?: string | null;
    ahead?: number | null;
    behind?: number | null;
    conflicts?: boolean | null;
    files?: string[];
    diff?: {
        files: number;
        insertions: number;
        deletions: number;
        total: number;
    } | null;
}
export interface LoopContextInput {
    issue?: Issue | null;
    idea?: Idea | null;
    task?: TaskState | null;
    pr?: GitHubPrStatus | null;
    checkLogs?: Array<{
        name: string;
        log: string;
    }>;
    reviewComments?: PrComment[];
    git?: LoopGitContext | null;
    workflow?: Record<string, unknown> | null;
    budgets?: Record<string, unknown> | null;
    available?: string[];
    blocked?: string[];
    changedSinceLastLoop?: string | null;
    ownerDecisions?: OwnerDecision[];
}
export declare function formatLoopContext(input: LoopContextInput): string;
