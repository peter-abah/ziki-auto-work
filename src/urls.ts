import type { Idea, Issue, JobConfig } from "./types.js";

export function baseUrl(job: JobConfig): string {
  return job.ziki.baseUrl.replace(/\/+$/, "");
}

export function issueUrl(job: JobConfig, issue: { number: number | string }): string {
  return `${baseUrl(job)}/${job.ziki.projectSlug}/${issue.number}`;
}

export function ideaUrl(job: JobConfig, idea: { number: number | string }): string {
  return `${baseUrl(job)}/${job.ziki.projectSlug}/ideas/${idea.number}`;
}

export function escalationUrl(job: JobConfig, issueNumber: number | string | null): string {
  return issueNumber ? issueUrl(job, { number: issueNumber }) : `${baseUrl(job)}/inbox`;
}

export function issueLabel(issue: Issue | { number: number | string; title: string }): string {
  return `#${issue.number} ${issue.title}`;
}

export function ideaLabel(idea: Idea | { number: number | string; title: string }): string {
  return `idea #${idea.number} ${idea.title}`;
}
