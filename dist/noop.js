function resolveStatuses(policy) {
    const statuses = policy?.statuses;
    if (!Array.isArray(statuses) || !statuses.every((entry) => typeof entry === "number")) {
        throw new Error("noop.statuses must be an array of numbers (run `auto-work migrate`)");
    }
    return new Set(statuses);
}
export function resolvePatterns(policy) {
    const patterns = policy?.patterns;
    if (!patterns || typeof patterns !== "object" || Array.isArray(patterns)) {
        throw new Error("noop.patterns must be an object of action -> regex strings (run `auto-work migrate`)");
    }
    const out = {};
    for (const [action, list] of Object.entries(patterns)) {
        if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
            throw new Error(`noop.patterns.${action} must be an array of regex strings (run \`auto-work migrate\`)`);
        }
        out[action] = list.map((source) => new RegExp(source, "i"));
    }
    return out;
}
export function errorMessage(error) {
    if (error && typeof error === "object") {
        const body = error.body;
        if (body && typeof body === "object") {
            const record = body;
            const message = record.message ?? record.error;
            if (typeof message === "string" && message.trim())
                return message;
        }
        const message = error.message;
        if (typeof message === "string" && message.trim())
            return message;
    }
    return String(error);
}
export function isNoopZikiError(error, patterns, policy) {
    const status = Number(error?.status ?? 0);
    if (!resolveStatuses(policy).has(status))
        return false;
    const message = errorMessage(error);
    return patterns.some((pattern) => pattern.test(message));
}
/** Resolve one action's compiled patterns (e.g. "reclaim") from policy. */
export function noopPatterns(policy, action) {
    return resolvePatterns(policy)[action] ?? [];
}
//# sourceMappingURL=noop.js.map