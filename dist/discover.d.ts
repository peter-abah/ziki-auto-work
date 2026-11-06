import { runCommand } from "./platform/spawn.js";
export type Runner = typeof runCommand;
export interface RepoCandidate {
    fullName: string;
    url: string;
    sshUrl?: string;
    description?: string;
    isFork: boolean;
    isArchived: boolean;
    stars: number;
    updatedAt?: string;
}
export interface RepoInfo {
    fullName: string;
    cloneUrl: string;
    sshUrl?: string;
    defaultBranch: string;
    isFork: boolean;
    parent?: string;
    archived: boolean;
}
export interface ForkResult {
    forkOwner: string;
    forkRepo: string;
    forkUrl: string;
    forkGitUrl: string;
    exists: boolean;
    created: boolean;
    needsFork: boolean;
}
import type { DiscoverPolicyConfig } from "./types.js";
export interface ResolvedDiscoverTimeouts {
    searchMs: number;
    apiMs: number;
    protocolMs: number;
    forkMs: number;
    forkAttempts: number;
    forkRetryMs: number;
}
export interface ResolvedDiscoverPolicy {
    platformSuffixes: Record<string, string[]>;
    platformPatterns: Record<string, string[]>;
    scores: Record<string, number>;
    starDivisor: number;
    starCap: number;
    skipArchived: boolean;
    stackMap: Record<string, string>;
    stackPlatform: Record<string, string>;
    stackPlatformDefault: string;
    searchLimit: number;
    timeouts: ResolvedDiscoverTimeouts;
}
/** Resolve and validate the discover policy (init templates fill every key). */
export declare function resolveDiscoverPolicy(policy: DiscoverPolicyConfig | null | undefined): ResolvedDiscoverPolicy;
export declare function parseRepoRef(value: string | undefined): {
    owner: string;
    name: string;
} | null;
export declare function repoName(fullName: string): string;
export declare function inferPlatform(name: string, policy?: DiscoverPolicyConfig | null | undefined): string | null;
export declare function rankCandidates(candidates: RepoCandidate[], slug: string, platform: string | null, policy?: DiscoverPolicyConfig | null | undefined): RepoCandidate[];
export declare function githubLogin(gh?: string, runner?: Runner, timeoutMs?: number): Promise<string>;
export declare function searchRepos(slug: string, options?: {
    gh?: string;
    runner?: Runner;
    limit?: number;
    policy?: DiscoverPolicyConfig | null | undefined;
}): Promise<RepoCandidate[]>;
export declare function repoInfo(fullName: string, gh?: string, runner?: Runner, timeoutMs?: number): Promise<RepoInfo | null>;
export declare function listBranches(fullName: string, gh?: string, runner?: Runner, timeoutMs?: number): Promise<string[]>;
export declare function gitProtocol(gh?: string, runner?: Runner, timeoutMs?: number): Promise<"ssh" | "https">;
export declare function pickCloneUrl(info: RepoInfo, protocol?: "ssh" | "https"): string;
export declare function ensureFork(options: {
    upstream: string;
    user: string;
    createFork: boolean;
    org?: string;
    gh?: string;
    runner?: Runner;
    policy?: DiscoverPolicyConfig | null | undefined;
}): Promise<ForkResult>;
export declare function detectedStackAt(dir: string, stackMap?: Record<string, string> | null | undefined): string;
/** Stack → platform via policy (e.g. flutter → desktop, default web). */
export declare function stackPlatform(stack: string, policy?: DiscoverPolicyConfig | null | undefined): string;
