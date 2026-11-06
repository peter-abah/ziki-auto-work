function requirePolicyNumber(policy, key, fallback) {
    const value = policy?.[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`heartbeatPolicy.${key} must be a non-negative number (run \`auto-work migrate\`)`);
    }
    return value;
}
/**
 * Heartbeat cadence, derived from Ziki's own workflow when available.
 * Explicit config always wins; otherwise take the tighter of the live
 * workflow value and the policy default (never slower than the default,
 * so a generous server value can't silently stretch our claims).
 * The workflow key itself is policy (heartbeatPolicy.workflowKey).
 */
export function resolveHeartbeatIntervalMs(ctx) {
    const policy = ctx.policy;
    let fallback;
    if (typeof ctx.timing?.heartbeatDefaultMs === "number" && ctx.timing.heartbeatDefaultMs > 0) {
        fallback = ctx.timing.heartbeatDefaultMs;
    }
    else {
        const value = policy?.intervalMs;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error("heartbeatPolicy.intervalMs is required (run `auto-work migrate`)");
        }
        fallback = value;
    }
    if (typeof ctx.timing?.heartbeatMs === "number" && ctx.timing.heartbeatMs > 0) {
        return ctx.timing.heartbeatMs;
    }
    const key = typeof policy?.workflowKey === "string" && policy.workflowKey ? policy.workflowKey : "heartbeatMinutes";
    const live = Number(ctx.zikiWorkflow?.[key]);
    if (Number.isFinite(live) && live > 0)
        return Math.min(live * 60_000, fallback);
    return fallback;
}
function eligibleStates(policy) {
    const states = policy?.eligibleStates;
    if (!Array.isArray(states) || !states.length || !states.every((entry) => typeof entry === "string")) {
        throw new Error("heartbeatPolicy.eligibleStates must be a non-empty string array (run `auto-work migrate`)");
    }
    return states;
}
export function heartbeatDue(task, now = Date.now(), intervalMs, policy) {
    if (!task.claimId || !task.id || !task.agentName)
        return false;
    if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < 0) {
        throw new Error("heartbeatDue requires an explicit intervalMs from policy (no default)");
    }
    if (!eligibleStates(policy).includes(task.status))
        return false;
    if (task.nextHeartbeatAt) {
        const next = Date.parse(task.nextHeartbeatAt);
        if (Number.isFinite(next) && next > now)
            return false;
    }
    const last = task.lastHeartbeatAt ? Date.parse(task.lastHeartbeatAt) : 0;
    return !Number.isFinite(last) || now - last >= intervalMs;
}
export function heartbeatFailure(error, policy) {
    const lost = policy?.lostStatuses;
    if (!Array.isArray(lost) || !lost.every((entry) => typeof entry === "number")) {
        throw new Error("heartbeatPolicy.lostStatuses must be an array of numbers (run `auto-work migrate`)");
    }
    const rateLimitMs = requirePolicyNumber(policy, "rateLimitMs", NaN);
    const genericMs = requirePolicyNumber(policy, "genericMs", NaN);
    const status = Number(error?.status ?? 0);
    if (lost.includes(status)) {
        return { claimLost: true, retryMs: 0 };
    }
    if (status === 429) {
        return { claimLost: false, retryMs: rateLimitMs };
    }
    return { claimLost: false, retryMs: genericMs };
}
export function applyHeartbeatSuccess(task, now = Date.now(), intervalMs) {
    if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < 0) {
        throw new Error("applyHeartbeatSuccess requires an explicit intervalMs from policy (no default)");
    }
    const at = new Date(now).toISOString();
    task.lastHeartbeatAt = at;
    task.lastHeartbeatAttemptAt = at;
    task.nextHeartbeatAt = new Date(now + intervalMs).toISOString();
}
export function applyHeartbeatFailure(task, error, now = Date.now(), policy) {
    const failure = heartbeatFailure(error, policy);
    const at = new Date(now).toISOString();
    task.lastHeartbeatAttemptAt = at;
    task.nextHeartbeatAt = failure.claimLost ? undefined : new Date(now + failure.retryMs).toISOString();
    if (failure.claimLost) {
        task.claimId = undefined;
        if (task.status !== "delivered")
            task.status = "queued";
        task.lastError = "claim lost";
    }
    else {
        task.lastError = error instanceof Error ? error.message : String(error);
    }
    return failure;
}
//# sourceMappingURL=heartbeat.js.map