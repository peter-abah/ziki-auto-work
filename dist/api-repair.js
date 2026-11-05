function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function contractKey(method, pathname) {
    const normalized = pathname
        .split("?")[0]
        .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id")
        .replace(/\/\d+(?=\/|$)/g, "/:n");
    return `${method.toUpperCase()} ${normalized}`;
}
export function stripRejectedFields(body, rejected) {
    if (!isObject(body) || !rejected.length)
        return body;
    const next = { ...body };
    for (const key of rejected)
        delete next[key];
    return next;
}
export function recordRejected(contracts, key, rejected) {
    if (!rejected.length)
        return;
    const current = contracts[key];
    contracts[key] = {
        rejected: [...new Set([...(current?.rejected ?? []), ...rejected])],
        updatedAt: new Date().toISOString()
    };
}
function getContainer(body, path) {
    let current = body;
    for (const part of path) {
        if (!isObject(current) && !Array.isArray(current))
            return null;
        current = current[part];
    }
    return current;
}
function setContainerValue(body, path, value) {
    if (!path.length)
        return false;
    let current = body;
    for (const part of path.slice(0, -1)) {
        if (!isObject(current) && !Array.isArray(current))
            return false;
        current = current[part];
    }
    if (!isObject(current) && !Array.isArray(current))
        return false;
    current[path.at(-1)] = value;
    return true;
}
function validationIssues(errorBody) {
    if (!isObject(errorBody))
        return [];
    const details = errorBody.details;
    if (!Array.isArray(details))
        return [];
    return details.filter(isObject);
}
export function repairApiBody(body, errorBody) {
    if (!isObject(body))
        return null;
    const next = structuredClone(body);
    const rejected = [];
    let changed = false;
    for (const issue of validationIssues(errorBody)) {
        const path = Array.isArray(issue.path) ? issue.path : [];
        if (issue.code === "unrecognized_keys") {
            const keys = Array.isArray(issue.keys) ? issue.keys.filter((key) => typeof key === "string") : [];
            const container = getContainer(next, path);
            if (isObject(container)) {
                for (const key of keys) {
                    if (key in container) {
                        delete container[key];
                        rejected.push(key);
                        changed = true;
                    }
                }
            }
            continue;
        }
        if (issue.code === "too_big" && typeof issue.maximum === "number") {
            const current = getContainer(next, path);
            if (typeof current === "string" && current.length > issue.maximum) {
                changed = setContainerValue(next, path, current.slice(0, issue.maximum)) || changed;
            }
            else if (Array.isArray(current) && current.length > issue.maximum) {
                changed = setContainerValue(next, path, current.slice(0, issue.maximum)) || changed;
            }
        }
    }
    if (isObject(errorBody) && typeof errorBody.field === "string" && errorBody.field in next) {
        delete next[errorBody.field];
        rejected.push(errorBody.field);
        changed = true;
    }
    return changed ? { body: next, changed, rejected } : null;
}
export function formatApiErrorDetails(errorBody) {
    const issues = validationIssues(errorBody);
    if (!issues.length)
        return "";
    const text = issues
        .slice(0, 3)
        .map((issue) => {
        const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
        const message = typeof issue.message === "string" ? issue.message : "";
        return [path, message].filter(Boolean).join(": ");
    })
        .filter(Boolean)
        .join("; ");
    return text ? ` (${text})` : "";
}
//# sourceMappingURL=api-repair.js.map