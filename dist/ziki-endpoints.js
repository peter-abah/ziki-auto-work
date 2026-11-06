/**
 * Config-driven Ziki endpoints.
 *
 * Every Ziki URL the client calls lives here as a template, so URL-shape
 * changes (new path segments, renamed routes, org prefixes) are fixed in
 * CONFIG — never in code. The agent may propose template/vars changes through
 * the approval-gated repair flow; see RepairConfig.
 *
 * Placeholders:
 * - `{name}` — required; interpolated from vars + identity fields. Unknown
 *   names are a config validation error, never a silent wrong URL.
 * - `{name?}` — optional; drops out with slash-collapse when empty/absent.
 *
 * Built-in identity vars (always available, no declaration needed):
 * `projectId`, `projectSlug`, `orgSlug`, `platform`.
 */
export const BUILTIN_IDENTITY_VARS = ["projectId", "projectSlug", "orgSlug", "platform"];
export const DEFAULT_ENDPOINTS = {
    work: {
        feed: "/{org?}/{project}/work"
    },
    agents: {
        me: "/api/v1/agents/me",
        list: "/api/v1/agents",
        get: "/api/v1/agents/{username}",
        skills: "/api/v1/agents/me/skills",
        skill: "/api/v1/agents/me/skills/{tag}",
        skillTags: "/api/v1/skill-tags",
        picture: "/api/v1/agents/me/picture",
        dismissRequest: "/api/v1/agents/me/requests/{id}/done",
        history: "/api/v1/agents/me/history",
        points: "/api/v1/agents/me/points"
    },
    projects: {
        list: "/api/v1/projects",
        get: "/api/v1/projects/{project}",
        mistakes: "/api/v1/projects/{project}/mistakes",
        notes: "/api/v1/projects/{project}/notes",
        notesComments: "/api/v1/projects/{project}/notes/comments",
        noteComment: "/api/v1/projects/{project}/notes/comments/{comment}/{action}",
        myNotes: "/api/v1/projects/{project}/notes/mine",
        myNote: "/api/v1/projects/{project}/notes/mine/{note}"
    },
    platforms: {
        list: "/api/v1/platforms"
    },
    issues: {
        list: "/api/v1/issues",
        counts: "/api/v1/issues/counts",
        get: "/api/v1/issues/{issue}",
        comments: "/api/v1/issues/{issue}/comments",
        bid: "/api/v1/issues/{issue}/bid",
        confirmations: "/api/v1/issues/{issue}/confirmations",
        open: "/api/v1/issues/{issue}/open",
        stake: "/api/v1/issues/{issue}/stake",
        getStake: "/api/v1/issues/{issue}/stake",
        heartbeat: "/api/v1/issues/{issue}/heartbeat",
        extend: "/api/v1/issues/{issue}/extend",
        release: "/api/v1/issues/{issue}/release",
        reclaim: "/api/v1/issues/{issue}/reclaim",
        importance: "/api/v1/issues/{issue}/importance",
        abandonVotes: "/api/v1/issues/{issue}/abandon-votes",
        closeSuggestions: "/api/v1/issues/{issue}/close-suggestions",
        close: "/api/v1/issues/{issue}/close",
        reward: "/api/v1/issues/{issue}/reward",
        getReward: "/api/v1/issues/{issue}/reward",
        platform: "/api/v1/issues/{issue}/platform",
        pullRequest: "/api/v1/issues/{issue}/pull-request",
        delivery: "/api/v1/issues/{issue}/delivery",
        getDelivery: "/api/v1/issues/{issue}/delivery",
        pullRequestStatus: "/api/v1/issues/{issue}/pull-request-status",
        testResults: "/api/v1/issues/{issue}/test-results",
        getTestResults: "/api/v1/issues/{issue}/test-results",
        merge: "/api/v1/issues/{issue}/merge",
        mergeReviews: "/api/v1/issues/{issue}/merge-reviews",
        deployment: "/api/v1/issues/{issue}/deployment",
        resolve: "/api/v1/issues/{issue}/resolve"
    },
    ideas: {
        list: "/api/v1/ideas",
        get: "/api/v1/ideas/{idea}",
        verdicts: "/api/v1/ideas/{idea}/verdicts",
        convert: "/api/v1/ideas/{idea}/convert",
        reject: "/api/v1/ideas/{idea}/reject",
        archive: "/api/v1/ideas/{idea}/archive",
        platform: "/api/v1/ideas/{idea}/platform"
    },
    comments: {
        votes: "/api/v1/comments/{comment}/votes"
    },
    bids: {
        award: "/api/v1/bids/{bid}/award",
        votes: "/api/v1/bids/{bid}/votes"
    },
    offers: {
        accept: "/api/v1/offers/{offer}/accept"
    },
    reviews: {
        accept: "/api/v1/reviews/{offer}/accept"
    },
    stakes: {
        refresh: "/api/v1/stakes/{stake}/refresh",
        votes: "/api/v1/stakes/{stake}/votes"
    },
    jobs: {
        get: "/api/v1/jobs/{job}",
        submissions: "/api/v1/jobs/{job}/submissions",
        submitReview: "/api/v1/jobs/submissions/{submission}/reviews",
        acceptReview: "/api/v1/jobs/reviews/{offer}/accept"
    },
    escalations: {
        create: "/api/v1/escalations",
        get: "/api/v1/escalations/{id}"
    },
    questions: {
        create: "/api/v1/questions",
        get: "/api/v1/questions/{id}"
    },
    inbox: {
        list: "/api/v1/inbox",
        read: "/api/v1/inbox/read"
    }
};
const PLACEHOLDER = /\{([A-Za-z0-9_]+)(\?)?\}/g;
const SAFE_VAR_NAME = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_VAR_NAMES = new Set(["__proto__", "constructor", "prototype"]);
/** Placeholders filled per call site (IDs, tags), not from config. */
const CALLSITE_PARAMS = new Set([
    "issue", "idea", "bid", "offer", "job", "submission", "stake",
    "comment", "note", "action", "username", "tag", "project", "id"
]);
/** All variables available for interpolation: explicit vars + identity fields. */
export function endpointVars(ziki) {
    const vars = {};
    for (const [key, value] of Object.entries(ziki.vars ?? {})) {
        if (typeof value === "string" && value)
            vars[key] = value;
    }
    if (ziki.projectId)
        vars.projectId = ziki.projectId;
    if (ziki.projectSlug)
        vars.project = ziki.projectSlug;
    if (ziki.orgSlug)
        vars.org = ziki.orgSlug;
    if (ziki.platform)
        vars.platform = ziki.platform;
    return vars;
}
/**
 * Render one endpoint template. Required vars missing → throw (fail loud,
 * never a silently wrong URL). Optional `{var?}` drops out with
 * slash-collapse. Relative paths only — absolute URLs and schemes are
 * rejected (base URL stays immutable).
 */
export function renderEndpoint(template, vars) {
    if (typeof template !== "string" || !template.startsWith("/")) {
        throw new Error(`endpoint template must be a relative path starting with "/": ${JSON.stringify(template)}`);
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(template)) {
        throw new Error(`endpoint template must not contain a scheme or host: ${template}`);
    }
    const rendered = template.replace(PLACEHOLDER, (_match, name, optional) => {
        if (FORBIDDEN_VAR_NAMES.has(name))
            throw new Error(`forbidden variable name: ${name}`);
        const raw = vars[name];
        const value = raw === undefined || raw === null ? raw : String(raw);
        if (value === undefined || value === null || value === "") {
            if (optional)
                return "";
            throw new Error(`endpoint template needs $${name}, which is not set`);
        }
        return value;
    });
    // NOTE: fresh regex (no /g state) — the shared PLACEHOLDER carries lastIndex.
    if (/\{[A-Za-z0-9_]+\??\}/.test(rendered)) {
        throw new Error(`unresolved placeholder left in endpoint: ${rendered}`);
    }
    return rendered.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}
/** Resolve a named endpoint against profile config (falls back to built-ins). */
export function resolveEndpoint(ziki, group, name, params = {}) {
    const configured = ziki.endpoints?.[group]?.[name];
    const fallback = DEFAULT_ENDPOINTS[group]?.[name];
    const template = configured ?? fallback;
    if (!template)
        throw new Error(`unknown endpoint: ${group}.${name}`);
    const vars = { ...endpointVars(ziki) };
    for (const [key, value] of Object.entries(params)) {
        if (FORBIDDEN_VAR_NAMES.has(key))
            throw new Error(`forbidden variable name: ${key}`);
        if (value !== undefined && value !== null)
            vars[key] = String(value);
    }
    return renderEndpoint(template, vars);
}
/** Validate a user/agent-supplied endpoints map. Returns error strings (empty = valid). */
export function validateEndpoints(endpoints, knownVars, label = "ziki.endpoints") {
    const errors = [];
    if (endpoints === undefined)
        return errors;
    if (typeof endpoints !== "object" || endpoints === null || Array.isArray(endpoints)) {
        return [`${label} must be an object of group -> name -> template`];
    }
    const known = new Set([...BUILTIN_IDENTITY_VARS, "project", "org", ...knownVars]);
    for (const [group, names] of Object.entries(endpoints)) {
        if (typeof names !== "object" || names === null || Array.isArray(names)) {
            errors.push(`${label}.${group} must be an object of name -> template`);
            continue;
        }
        for (const [name, template] of Object.entries(names)) {
            const where = `${label}.${group}.${name}`;
            if (typeof template !== "string" || !template) {
                errors.push(`${where} must be a non-empty string`);
                continue;
            }
            if (!template.startsWith("/")) {
                errors.push(`${where} must be a relative path starting with "/"`);
            }
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(template)) {
                errors.push(`${where} must not contain a scheme or host`);
                continue;
            }
            for (const match of template.matchAll(/\{([A-Za-z0-9_]+)(\?)?\}/g)) {
                const varName = match[1];
                if (FORBIDDEN_VAR_NAMES.has(varName)) {
                    errors.push(`${where} uses a forbidden variable name: ${varName}`);
                }
                else if (!known.has(varName) && !CALLSITE_PARAMS.has(varName)) {
                    errors.push(`${where} uses unknown variable {${varName}} (known: ${[...known].join(", ")}, or call-site: ${[...CALLSITE_PARAMS].join(", ")})`);
                }
            }
            const braces = (template.match(/\{/g) ?? []).length - (template.match(/\}/g) ?? []).length;
            if (braces !== 0)
                errors.push(`${where} has unbalanced braces`);
        }
    }
    return errors;
}
/** Validate a vars map. */
export function validateEndpointVars(vars, label = "ziki.vars") {
    const errors = [];
    if (vars === undefined)
        return errors;
    if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
        return [`${label} must be an object of name -> value`];
    }
    for (const [key, value] of Object.entries(vars)) {
        if (!SAFE_VAR_NAME.test(key) || key.includes(".")) {
            errors.push(`${label} key "${key}" must match [A-Za-z0-9_-]+ (no dots)`);
        }
        if (FORBIDDEN_VAR_NAMES.has(key))
            errors.push(`${label} key "${key}" is forbidden`);
        if (typeof value !== "string" || !value) {
            errors.push(`${label}.${key} must be a non-empty string`);
        }
        else if (/\s/.test(value)) {
            errors.push(`${label}.${key} must not contain whitespace`);
        }
    }
    return errors;
}
/**
 * Split a work feed URL like `https://ziki.dev/zedu/desktop/work` into
 * `{ org, project }`. Returns null when the shape is unrecognized.
 */
export function parseWorkUrl(workUrl) {
    if (!workUrl)
        return null;
    try {
        const path = new URL(workUrl).pathname.split("/").filter(Boolean);
        if (path.length === 3 && path[2] === "work" && path[0] && path[1]) {
            return { org: path[0], project: path[1] };
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=ziki-endpoints.js.map