function envSuffixes(policy) {
    const suffixes = policy?.envSuffixes;
    if (!suffixes || typeof suffixes !== "object" || Array.isArray(suffixes)) {
        throw new Error("urls.envSuffixes must be an object of suffix -> environment (run `auto-work migrate`)");
    }
    for (const [key, value] of Object.entries(suffixes)) {
        if (typeof value !== "string" || !value) {
            throw new Error(`urls.envSuffixes.${key} must be a non-empty string (run \`auto-work migrate\`)`);
        }
    }
    return suffixes;
}
export function deploymentEnvironment(key, policy) {
    const suffix = key.split(":").pop() ?? "";
    const env = envSuffixes(policy)[suffix];
    return env === "dev" || env === "staging" || env === "prod" ? env : null;
}
export function workTargetKey(key, issueId, ideaId) {
    if (issueId)
        return `issue:${issueId}`;
    if (ideaId)
        return `idea:${ideaId}`;
    return `key:${key}`;
}
//# sourceMappingURL=work-key.js.map