import type { CheckRunResult, ProfileConfig } from "./types.js";
import type { Logger } from "./log.js";
export declare function resolveCommand(profile: ProfileConfig, command: string): string;
export declare function parseTestFailures(output: string): string[];
export declare function runChecks(profile: ProfileConfig, worktree: string, options: {
    changedFiles: string[];
    logger?: Logger;
}): Promise<CheckRunResult>;
export declare function protectedFiles(files: string[], patterns: string[] | null | undefined): string[];
export declare function scanSecretsText(text: string, patterns: string[] | null | undefined): string[];
export declare function scanSecrets(diff: string, patterns: string[] | null | undefined): string[];
