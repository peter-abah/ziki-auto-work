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
export declare function parseRepoRef(value: string | undefined): {
    owner: string;
    name: string;
} | null;
export declare function repoName(fullName: string): string;
export declare function inferPlatform(name: string): string | null;
export declare function rankCandidates(candidates: RepoCandidate[], slug: string, platform: string | null): RepoCandidate[];
export declare function githubLogin(gh?: string, runner?: Runner): Promise<string>;
export declare function searchRepos(slug: string, options?: {
    gh?: string;
    runner?: Runner;
    limit?: number;
}): Promise<RepoCandidate[]>;
export declare function repoInfo(fullName: string, gh?: string, runner?: Runner): Promise<RepoInfo | null>;
export declare function listBranches(fullName: string, gh?: string, runner?: Runner): Promise<string[]>;
export declare function gitProtocol(gh?: string, runner?: Runner): Promise<"ssh" | "https">;
export declare function pickCloneUrl(info: RepoInfo, protocol?: "ssh" | "https"): string;
export declare function ensureFork(options: {
    upstream: string;
    user: string;
    createFork: boolean;
    org?: string;
    gh?: string;
    runner?: Runner;
}): Promise<ForkResult>;
export declare function detectedStackAt(dir: string): string;
