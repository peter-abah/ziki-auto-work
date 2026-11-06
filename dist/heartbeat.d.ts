import type { TaskState, TimingConfig } from "./types.js";
export declare const HEARTBEAT_INTERVAL_MS: number;
export interface HeartbeatTimingInput {
    timing?: Pick<TimingConfig, "heartbeatMs" | "heartbeatDefaultMs"> | null | undefined;
    zikiWorkflow?: Record<string, unknown> | null | undefined;
}
/**
 * Heartbeat cadence, derived from Ziki's own workflow when available.
 * Explicit config always wins; otherwise take the tighter of the live
 * workflow value and the built-in default (never slower than the default,
 * so a generous server value can't silently stretch our claims).
 */
export declare function resolveHeartbeatIntervalMs(ctx: HeartbeatTimingInput): number;
export interface HeartbeatFailure {
    claimLost: boolean;
    retryMs: number;
}
export declare function heartbeatDue(task: TaskState, now?: number, intervalMs?: number): boolean;
export declare function heartbeatFailure(error: unknown): HeartbeatFailure;
export declare function applyHeartbeatSuccess(task: TaskState, now?: number, intervalMs?: number): void;
export declare function applyHeartbeatFailure(task: TaskState, error: unknown, now?: number): HeartbeatFailure;
