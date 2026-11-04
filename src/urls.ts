import type { Idea, Issue, ProfileConfig } from "./types.js";

export function baseUrl(profile: ProfileConfig): string {
  return profile.ziki.baseUrl.replace(/\/+$/, "");
}

export function issueUrl(profile: ProfileConfig, issue: { number: number | string }): string {
  return `${baseUrl(profile)}/${profile.ziki.projectSlug}/${issue.number}`;
}

export function ideaUrl(profile: ProfileConfig, idea: { number: number | string }): string {
  return `${baseUrl(profile)}/${profile.ziki.projectSlug}/ideas/${idea.number}`;
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
