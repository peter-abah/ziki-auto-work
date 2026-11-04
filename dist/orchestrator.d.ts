import type { Issue, RunLimitConfig } from "./types.js";
export declare function normalizeCommitMessage(message: string | undefined, issue: Issue, commitTypes: string[]): string;
export declare function runLoop(options?: {
    profileName?: string;
    foreground?: boolean;
    verbose?: boolean;
    once?: boolean;
    dryRun?: boolean;
    limits?: Partial<RunLimitConfig> | null;
}): Promise<number>;
export declare function runOnceDry(profileName?: string): Promise<number>;
