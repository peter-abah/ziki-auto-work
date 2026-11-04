import type { Issue, ProfileConfig } from "./types.js";
export declare function slugify(text: string, max?: number): string;
export declare function branchName(issue: {
    number: number | string;
}, title: string, prefix?: string): string;
export declare function summarizeChecks(rollup: Array<Record<string, unknown>>): "passing" | "failing" | "pending" | "none";
export interface PrComment {
    id: string;
    author: string;
    body: string;
    path?: string;
    line?: number | null;
    url?: string;
    createdAt?: string;
    kind: "conversation" | "review";
}
export interface PrCheck {
    name: string;
    status: string;
    conclusion: string | null;
    url?: string;
}
export interface PrReview {
    author: string;
    state: string;
    body: string;
    submittedAt?: string;
}
export interface GitHubPrStatus {
    number?: number;
    url: string;
    state: string;
    merged: boolean;
    mergedInto: string | null;
    mergeCommitSha: string | null;
    headSha: string | null;
    headRefName: string | null;
    baseRefName: string | null;
    checks: "passing" | "failing" | "pending" | "none";
    mergeable: boolean | null;
    reviewDecision: string | null;
    comments: PrComment[];
    reviews: PrReview[];
    checkRuns: PrCheck[];
    isDraft?: boolean;
}
export declare class GitHub {
    profile: ProfileConfig;
    profileName: string;
    repoDir: string;
    logger: {
        info: (m: string, f?: Record<string, unknown>) => Promise<void>;
        warn: (m: string, f?: Record<string, unknown>) => Promise<void>;
    } | null;
    constructor(options: {
        profile: ProfileConfig;
        profileName: string;
        reposDir: string;
        logger?: GitHub["logger"];
    });
    private retryCommand;
    git(args: string[], options?: {
        cwd?: string;
        timeoutMs?: number;
        retry?: boolean;
    }): Promise<import("./platform/spawn.js").RunResult>;
    gh(args: string[], options?: {
        cwd?: string;
        timeoutMs?: number;
        retry?: boolean;
    }): Promise<import("./platform/spawn.js").RunResult>;
    ensureRepo(): Promise<string>;
    copyEnvTo(worktree: string): Promise<void>;
    baseSha(): Promise<string>;
    createWorktree(branch: string, dir: string): Promise<string>;
    createScratchWorktree(dir: string): Promise<string>;
    createReviewWorktree(prNumber: number, dir: string): Promise<string>;
    removeWorktree(dir: string, force?: boolean): Promise<void>;
    status(worktree: string): Promise<string>;
    changedFiles(worktree: string): Promise<string[]>;
    diffStats(worktree: string, ref?: string): Promise<{
        files: number;
        insertions: number;
        deletions: number;
        total: number;
    }>;
    stagedChangedFiles(worktree: string, ref?: string): Promise<string[]>;
    headSha(worktree: string): Promise<string>;
    commitAll(worktree: string, message: string): Promise<{
        committed: boolean;
        sha: string;
        alreadyCommitted?: boolean;
    }>;
    pushBranch(worktree: string, branch: string, options?: {
        force?: boolean;
    }): Promise<void>;
    findOpenPr(branch: string): Promise<any | null>;
    createPr(branch: string, title: string, body: string): Promise<{
        url: string;
        existed: boolean;
        branch: string;
    }>;
    prStatus(url: string): Promise<GitHubPrStatus>;
    private prNumber;
    prReviewComments(url: string): Promise<Array<{
        id: string;
        author: string;
        body: string;
        path?: string;
        line?: number | null;
        url?: string;
        createdAt?: string;
    }>>;
    failedCheckLogs(status: GitHubPrStatus, maxRuns?: number): Promise<Array<{
        name: string;
        log: string;
    }>>;
    updatePrBody(url: string, body: string): Promise<void>;
    closePr(url: string, comment?: string): Promise<void>;
    authStatus(): Promise<import("./platform/spawn.js").RunResult>;
    remoteAccess(url: string): Promise<import("./platform/spawn.js").RunResult>;
}
export declare const GENERIC_PR_TEMPLATE = "## Ticket\n\n{{ticket}}\n\n## Team lead\n\n{{teamLead}}\n\n## What changed\n\n{{description}}\n\n## Why\n\n{{why}}\n\n## How to test\n\n{{howToTest}}\n\n## What to expect\n\n{{whatToExpect}}\n\n## Test evidence\n\n- Tested against: {{testedAgainst}}\n- Tests: {{testResults}}\n\n## Screenshots / recording\n\n{{screenshots}}\n\n## Checks\n\n{{checks}}\n\n## Risks / follow-ups\n\n{{risks}}\n\n## Notes\n\n{{notes}}\n";
export interface PrBodyInput {
    issue: Issue;
    summary: string;
    description: string;
    testResults: string;
    testedAgainst?: string;
    howToTest?: string[];
    whatToExpect?: string;
    screenshots?: string[];
    checks?: string[];
    risks?: string[];
    notes?: string[];
}
export declare function buildPrBody(profile: ProfileConfig, input: PrBodyInput): Promise<string>;
