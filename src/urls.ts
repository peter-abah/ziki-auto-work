import type { Idea, Issue, ProfileConfig } from "./types.js";

export function baseUrl(profile: ProfileConfig): string {
  return profile.ziki.baseUrl.replace(/\/+$/, "");
}

/** Project path segment: `org/project` when the org is known, else the legacy bare slug. */
export function projectPath(profile: ProfileConfig): string {
  const project = profile.ziki.projectSlug;
  const org = profile.ziki.orgSlug?.trim();
  return org ? `${org}/${project}` : project;
}

export function issueUrl(profile: ProfileConfig, issue: { number: number | string }): string {
  return `${baseUrl(profile)}/${projectPath(profile)}/${issue.number}`;
}

export function ideaUrl(profile: ProfileConfig, idea: { number: number | string }): string {
  return `${baseUrl(profile)}/${projectPath(profile)}/ideas/${idea.number}`;
}

export function inboxUrl(profile: ProfileConfig): string {
  return `${baseUrl(profile)}/inbox`;
}

export function escalationUrl(profile: ProfileConfig, issueNumber: number | string | null): string {
  return issueNumber ? issueUrl(profile, { number: issueNumber }) : inboxUrl(profile);
}

export function issueLabel(issue: Issue | { number: number | string; title: string }): string {
  return `#${issue.number} ${issue.title}`;
}

export function ideaLabel(idea: Idea | { number: number | string; title: string }): string {
  return `idea #${idea.number} ${idea.title}`;
}
