export function baseUrl(profile) {
    return profile.ziki.baseUrl.replace(/\/+$/, "");
}
export function issueUrl(profile, issue) {
    return `${baseUrl(profile)}/${profile.ziki.projectSlug}/${issue.number}`;
}
export function ideaUrl(profile, idea) {
    return `${baseUrl(profile)}/${profile.ziki.projectSlug}/ideas/${idea.number}`;
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