export function deploymentEnvironment(key) {
    const suffix = key.split(":").pop() ?? "";
    if (suffix === "on_dev")
        return "dev";
    if (suffix === "on_staging")
        return "staging";
    if (suffix === "on_prod")
        return "prod";
    return null;
}
export function workTargetKey(key, issueId, ideaId) {
    if (issueId)
        return `issue:${issueId}`;
    if (ideaId)
        return `idea:${ideaId}`;
    return `key:${key}`;
}
//# sourceMappingURL=work-key.js.map