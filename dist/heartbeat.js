export const HEARTBEAT_INTERVAL_MS = 10 * 60_000;
export function heartbeatDue(task, now = Date.now(), intervalMs = HEARTBEAT_INTERVAL_MS) {
    if (!task.claimId || !task.id || !task.agentName)
        return false;
    if (!["queued", "claimed", "working", "waiting_human", "delivered"].includes(task.status))
        return false;
    if (task.nextHeartbeatAt) {
        const next = Date.parse(task.nextHeartbeatAt);
        if (Number.isFinite(next) && next > now)
            return false;
    }
    const last = task.lastHeartbeatAt ? Date.parse(task.lastHeartbeatAt) : 0;
    return !Number.isFinite(last) || now - last >= intervalMs;
}
export function heartbeatFailure(error) {
    const status = Number(error?.status ?? 0);
    if ([403, 404, 409, 410].includes(status)) {
        return { claimLost: true, retryMs: 0 };
    }
    if (status === 429) {
        return { claimLost: false, retryMs: 15 * 60_000 };
    }
    return { claimLost: false, retryMs: 5 * 60_000 };
}
export function applyHeartbeatSuccess(task, now = Date.now(), intervalMs = HEARTBEAT_INTERVAL_MS) {
    const at = new Date(now).toISOString();
    task.lastHeartbeatAt = at;
    task.lastHeartbeatAttemptAt = at;
    task.nextHeartbeatAt = new Date(now + intervalMs).toISOString();
}
export function applyHeartbeatFailure(task, error, now = Date.now()) {
    const failure = heartbeatFailure(error);
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