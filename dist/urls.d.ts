import type { Idea, Issue, ProfileConfig } from "./types.js";
export declare function baseUrl(profile: ProfileConfig): string;
export declare function issueUrl(profile: ProfileConfig, issue: {
    number: number | string;
}): string;
export declare function ideaUrl(profile: ProfileConfig, idea: {
    number: number | string;
}): string;
export declare function inboxUrl(profile: ProfileConfig): string;
export declare function escalationUrl(profile: ProfileConfig, issueNumber: number | string | null): string;
export declare function issueLabel(issue: Issue | {
    number: number | string;
    title: string;
}): string;
export declare function ideaLabel(idea: Idea | {
    number: number | string;
    title: string;
}): string;
