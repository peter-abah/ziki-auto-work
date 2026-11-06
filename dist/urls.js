export function baseUrl(profile) {
    return profile.ziki.baseUrl.replace(/\/+$/, "");
}
/** Project path segment: `org/project` when the org is known, else the legacy bare slug. */
export function projectPath(profile) {
    const project = profile.ziki.projectSlug;
    const org = profile.ziki.orgSlug?.trim();
    return org ? `${org}/${project}` : project;
}
export function issueUrl(profile, issue) {
    return `${baseUrl(profile)}/${projectPath(profile)}/${issue.number}`;
}
export function ideaUrl(profile, idea) {
    return `${baseUrl(profile)}/${projectPath(profile)}/ideas/${idea.number}`;
}
export function inboxUrl(profile) {
    return `${baseUrl(profile)}/inbox`;
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