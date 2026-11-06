export function baseUrl(profile) {
    return profile.ziki.baseUrl.replace(/\/+$/, "");
}
/** Project path segment: `org/project` when the org is known, else the legacy bare slug. */
export function projectPath(profile) {
    const project = profile.ziki.projectSlug;
    const org = profile.ziki.orgSlug?.trim();
    return org ? `${org}/${project}` : project;
}
function urlTemplates(profile) {
    const urls = profile.urls;
    for (const key of ["issuePath", "ideaPath", "inboxPath"]) {
        const value = urls?.[key];
        if (typeof value !== "string" || !value.startsWith("/")) {
            throw new Error(`urls.${key} must be a relative path starting with "/" (run \`auto-work migrate\`)`);
        }
    }
    return {
        issuePath: urls?.issuePath,
        ideaPath: urls?.ideaPath,
        inboxPath: urls?.inboxPath
    };
}
/**
 * Render a URL path template. `{name}` interpolates; `{name?}` drops out
 * with slash-collapse when empty/absent (e.g. `{org?}` for tenants without
 * organisations). Unknown placeholders fail loud.
 */
function renderUrlPath(template, vars) {
    const rendered = template.replace(/\{([A-Za-z0-9_]+)(\?)?\}/g, (_match, name, optional) => {
        const value = vars[name];
        if (value === undefined || value === null || value === "") {
            if (optional)
                return "";
            throw new Error(`URL template needs $${name}, which is not set`);
        }
        return value;
    });
    if (/\{[A-Za-z0-9_]+\??\}/.test(rendered)) {
        throw new Error(`unresolved placeholder left in URL: ${rendered}`);
    }
    return rendered.replace(/\/{2,}/g, "/");
}
export function issueUrl(profile, issue) {
    const { issuePath } = urlTemplates(profile);
    const path = renderUrlPath(issuePath, {
        org: profile.ziki.orgSlug?.trim(),
        project: profile.ziki.projectSlug,
        issue: String(issue.number)
    });
    return `${baseUrl(profile)}${path}`;
}
export function ideaUrl(profile, idea) {
    const { ideaPath } = urlTemplates(profile);
    const path = renderUrlPath(ideaPath, {
        org: profile.ziki.orgSlug?.trim(),
        project: profile.ziki.projectSlug,
        idea: String(idea.number)
    });
    return `${baseUrl(profile)}${path}`;
}
export function inboxUrl(profile) {
    const { inboxPath } = urlTemplates(profile);
    return `${baseUrl(profile)}${renderUrlPath(inboxPath, {})}`;
}
export function escalationUrl(profile, issueNumber) {
    return issueNumber ? issueUrl(profile, { number: issueNumber }) : inboxUrl(profile);
}
export function issueLabel(issue) {
    return `#${issue.number} ${issue.title}`;
}
export function ideaLabel(idea) {
    return `idea #${idea.number} ${idea.title}`;
}
//# sourceMappingURL=urls.js.map