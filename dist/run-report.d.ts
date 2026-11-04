import type { ProfileConfig, ProfilePaths, RunSummary, State, StopReason } from "./types.js";
export declare function buildRunSummary(options: {
    state: State;
    profileName: string;
    profile: ProfileConfig;
    clean: boolean;
    stopReason: StopReason | "killed";
    endedAt?: string | null;
}): RunSummary;
export declare function formatRunSummary(summary: RunSummary, options?: {
    files?: boolean;
    inProgress?: boolean;
}): string;
export declare function writeRunSummary(profilePaths: ProfilePaths, summary: RunSummary): Promise<void>;
