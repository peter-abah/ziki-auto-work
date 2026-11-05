import type { TaskState } from "./types.js";
export declare const HEARTBEAT_INTERVAL_MS: number;
export interface HeartbeatFailure {
    claimLost: boolean;
    retryMs: number;
}
export declare function heartbeatDue(task: TaskState, now?: number, intervalMs?: number): boolean;
export declare function heartbeatFailure(error: unknown): HeartbeatFailure;
export declare function applyHeartbeatSuccess(task: TaskState, now?: number, intervalMs?: number): void;
export declare function applyHeartbeatFailure(task: TaskState, error: unknown, now?: number): HeartbeatFailure;
