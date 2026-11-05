function atLeastOne(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
export function resolveCapacity(profile, keys) {
    const workers = atLeastOne(keys.workers.length || keys.managers.length || 1);
    const totalKeys = atLeastOne(keys.workers.length + keys.managers.length || 1);
    const configured = profile.limits.maxConcurrentAgents;
    const agentCeiling = configured === "auto" || configured === null || configured === undefined
        ? totalKeys
        : atLeastOne(Number(configured));
    const bounded = (value, autoValue) => {
        if (value === undefined || value === null || value === "auto")
            return atLeastOne(autoValue);
        return atLeastOne(Number(value));
    };
    return {
        workers,
        totalKeys,
        agentCeiling,
        delivery: bounded(profile.limits.maxConcurrentDeliveries, Math.min(workers, agentCeiling)),
        review: bounded(profile.limits.maxConcurrentReviews, Math.min(workers, agentCeiling)),
        aux: bounded(profile.limits.maxConcurrentAux, Math.min(totalKeys, agentCeiling)),
        followup: bounded(profile.limits.maxConcurrentFollowUps, Math.min(workers, agentCeiling)),
        activeClaims: bounded(profile.limits.maxActiveClaims, workers),
        discovery: bounded(profile.limits.maxConcurrentDiscovery, 1),
        owner: 1
    };
}
export function underCap(count, cap) {
    if (cap === null || cap === "auto" || cap === undefined)
        return true;
    return count < Number(cap);
}
//# sourceMappingURL=capacity.js.map