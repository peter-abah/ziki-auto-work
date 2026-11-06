function requiredFloor(profile) {
    const floor = profile.capacity?.floor;
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 1) {
        throw new Error("capacity.floor must be a positive number (run `auto-work migrate`)");
    }
    return Math.floor(floor);
}
function atLeastFloor(floor, value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : floor;
}
export function resolveCapacity(profile, keys) {
    const floor = requiredFloor(profile);
    const atLeastOne = (value) => atLeastFloor(floor, value);
    const discoverySlots = profile.capacity?.discoverySlots;
    const ownerSlots = profile.capacity?.ownerSlots;
    if (typeof discoverySlots !== "number" || !Number.isFinite(discoverySlots) || discoverySlots < 0) {
        throw new Error("capacity.discoverySlots must be a non-negative number (run `auto-work migrate`)");
    }
    if (typeof ownerSlots !== "number" || !Number.isFinite(ownerSlots) || ownerSlots < 0) {
        throw new Error("capacity.ownerSlots must be a non-negative number (run `auto-work migrate`)");
    }
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
        discovery: bounded(profile.limits.maxConcurrentDiscovery, profile.capacity?.discoverySlots),
        owner: profile.capacity?.ownerSlots
    };
}
export function underCap(count, cap) {
    if (cap === null || cap === "auto" || cap === undefined)
        return true;
    return count < Number(cap);
}
//# sourceMappingURL=capacity.js.map