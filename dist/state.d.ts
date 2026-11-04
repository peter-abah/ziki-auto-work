import type { HistoryEntry, ProfilePaths, State, TaskState } from "./types.js";
export declare function emptyState(): State;
export declare function loadState(profilePaths: ProfilePaths): Promise<State>;
export declare function saveState(profilePaths: ProfilePaths, state: State): Promise<void>;
export declare function appendHistory(profilePaths: ProfilePaths, entry: HistoryEntry): Promise<void>;
export declare function readHistory(profilePaths: ProfilePaths, limit?: number): Promise<HistoryEntry[]>;
export declare function counterFor(state: State, date?: Date): State["counters"][string];
export declare function pruneState(state: State, { keepDays }?: {
    keepDays?: number | undefined;
}): State;
export declare function isAlive(pid: number): boolean;
export declare function acquireLock(profilePaths: ProfilePaths): Promise<{
    acquired: boolean;
    pid: number;
}>;
export declare function releaseLock(profilePaths: ProfilePaths): Promise<void>;
export declare function readPid(profilePaths: ProfilePaths): Promise<number | null>;
export declare function writePid(profilePaths: ProfilePaths, pid: number): Promise<void>;
export declare function clearPid(profilePaths: ProfilePaths): Promise<void>;
export declare function setPaused(profilePaths: ProfilePaths, paused: boolean): Promise<void>;
export declare function isPaused(profilePaths: ProfilePaths): Promise<boolean>;
export declare function setStopped(profilePaths: ProfilePaths, stopped: boolean): Promise<void>;
export declare function isStopped(profilePaths: ProfilePaths): Promise<boolean>;
export declare function taskKey(issue: {
    id?: string | null;
    number?: number | string | null;
} | null | undefined): string;
export declare function getTask(state: State, issue: {
    id?: string | null;
    number?: number | string | null;
}): TaskState | null;
export declare function setTask(state: State, issue: {
    id?: string | null;
    number?: number | string | null;
    title?: string | null;
}, patch: Partial<TaskState>): TaskState;
