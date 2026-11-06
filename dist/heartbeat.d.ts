import type { HeartbeatPolicyConfig, TaskState, TimingConfig } from "./types.js";
export interface HeartbeatTimingInput {
    timing?: Pick<TimingConfig, "heartbeatMs" | "heartbeatDefaultMs"> | null | undefined;
    policy?: HeartbeatPolicyConfig | null | undefined;
    zikiWorkflow?: Record<string, unknown> | null | undefined;
}
/**
 * Heartbeat cadence, derived from Ziki's own workflow when available.
 * Explicit config always wins; otherwise take the tighter of the live
 * workflow value and the policy default (never slower than the default,
 * so a generous server value can't silently stretch our claims).
 * The workflow key itself is policy (heartbeatPolicy.workflowKey).
 */
export declare function resolveHeartbeatIntervalMs(ctx: HeartbeatTimingInput): number;
export interface HeartbeatFailure {
    claimLost: boolean;
    retryMs: number;
}
export declare function heartbeatDue(task: TaskState, now: number | undefined, intervalMs: number, policy?: HeartbeatPolicyConfig | null | undefined): boolean;
export declare function heartbeatFailure(error: unknown, policy?: HeartbeatPolicyConfig | null | undefined): HeartbeatFailure;
export declare function applyHeartbeatSuccess(task: TaskState, now: number | undefined, intervalMs: number): void;
export declare function applyHeartbeatFailure(task: TaskState, error: unknown, now?: number, policy?: HeartbeatPolicyConfig | null | undefined): HeartbeatFailure;
