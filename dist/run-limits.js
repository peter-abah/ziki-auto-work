export function cyclesThisRun(state) {
    const started = Number(state.run?.startedCycles);
    if (Number.isFinite(started) && started >= 0) {
        return Math.max(0, state.cycles - started);
    }
    return Math.max(0, Number(state.cycles) || 0);
}
export function remainingCycles(state, maxCycles) {
    if (maxCycles === null)
        return null;
    return Math.max(0, maxCycles - cyclesThisRun(state));
}
export function limitReached(state, limits, now = Date.now()) {
    if (limits.maxCycles !== null && cyclesThisRun(state) >= limits.maxCycles)
        return "max-cycles";
    if (limits.maxDeliveriesTotal !== null && state.run.deliveries >= limits.maxDeliveriesTotal)
        return "max-deliveries";
    if (limits.stopAt) {
        const at = new Date(limits.stopAt).getTime();
        if (Number.isFinite(at) && now >= at)
            return "until";
    }
    if (limits.maxRuntimeMinutes !== null) {
        const started = state.run.startedAt ? new Date(state.run.startedAt).getTime() : now;
        if (now - started >= limits.maxRuntimeMinutes * 60 * 1000)
            return "max-runtime";
    }
    return null;
}
//# sourceMappingURL=run-limits.js.map