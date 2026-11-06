import { existsSync } from "node:fs";
import path from "node:path";
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

function requireStringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${path} must be an array of strings (run \`auto-work migrate\`)`);
  }
  return value as string[];
}

function requireStringMap(value: unknown, path: string): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object of string arrays (run \`auto-work migrate\`)`);
  }
  for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
    requireStringList(list, `${path}.${key}`);
  }
  return value as Record<string, string[]>;
}

function requireNumber(value: unknown, path: string, opts: { min?: number; integer?: boolean } = {}): number {
  const min = opts.min ?? 0;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    (opts.integer && !Number.isInteger(value))
  ) {
    throw new Error(`${path} must be a number >= ${min}${opts.integer ? " (integer)" : ""} (run \`auto-work migrate\`)`);
  }
  return value;
}

/** Resolve and validate the discover policy (init templates fill every key). */
export function resolveDiscoverPolicy(policy: DiscoverPolicyConfig | null | undefined): ResolvedDiscoverPolicy {
  if (!policy || typeof policy !== "object") {
    throw new Error("discover policy is required (run `auto-work migrate`)");
  }
  const scores = policy.scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    throw new Error("discover.scores must be an object of kind -> number (run `auto-work migrate`)");
  }
  const scoreValues: Record<string, number> = {};
  for (const key of ["exact", "prefix", "suffixExact", "suffix", "description", "forkBonus"]) {
    scoreValues[key] = requireNumber((scores as Record<string, unknown>)[key], `discover.scores.${key}`);
  }
  const timeouts = policy.timeouts;
  if (!timeouts || typeof timeouts !== "object") {
    throw new Error("discover.timeouts is required (run `auto-work migrate`)");
  }
  return {
    platformSuffixes: requireStringMap(policy.platformSuffixes, "discover.platformSuffixes"),
    platformPatterns: requireStringMap(policy.platformPatterns, "discover.platformPatterns"),
    scores: scoreValues,
    starDivisor: requireNumber(policy.starDivisor, "discover.starDivisor", { min: 1 }),
    starCap: requireNumber(policy.starCap, "discover.starCap", { min: 0 }),
    skipArchived: policy.skipArchived !== false,
    stackMap: requireFlatStringMap(policy.stackMap, "discover.stackMap"),
    stackPlatform: requireFlatStringMap(policy.stackPlatform, "discover.stackPlatform"),
    stackPlatformDefault:
      typeof policy.stackPlatformDefault === "string" && policy.stackPlatformDefault
        ? policy.stackPlatformDefault
        : (() => {
            throw new Error("discover.stackPlatformDefault must be a non-empty string (run `auto-work migrate`)");
          })(),
    searchLimit: requireNumber(policy.searchLimit, "discover.searchLimit", { min: 1, integer: true }),
    timeouts: {
      searchMs: requireNumber(timeouts.searchMs, "discover.timeouts.searchMs", { min: 1 }),
      apiMs: requireNumber(timeouts.apiMs, "discover.timeouts.apiMs", { min: 1 }),
      protocolMs: requireNumber(timeouts.protocolMs, "discover.timeouts.protocolMs", { min: 1 }),
      forkMs: requireNumber(timeouts.forkMs, "discover.timeouts.forkMs", { min: 1 }),
      forkAttempts: requireNumber(timeouts.forkAttempts, "discover.timeouts.forkAttempts", { min: 1, integer: true }),
      forkRetryMs: requireNumber(timeouts.forkRetryMs, "discover.timeouts.forkRetryMs", { min: 0 })
    }
  };
}

function requireFlatStringMap(value: unknown, path: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object of string -> string (run \`auto-work migrate\`)`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string" || !entry) {
      throw new Error(`${path}.${key} must be a non-empty string (run \`auto-work migrate\`)`);
    }
  }
  return value as Record<string, string>;
}

export function parseRepoRef(value: string | undefined): { owner: string; name: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const https = trimmed.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (https) return { owner: https[1]!, name: https[2]! };
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };
  const plain = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (plain) return { owner: plain[1]!, name: plain[2]! };
  return null;
}

export function repoName(fullName: string): string {
  return fullName.split("/")[1] ?? fullName;
}

export function inferPlatform(
  name: string,
  policy?: DiscoverPolicyConfig | null | undefined
): string | null {
  const { platformPatterns } = resolveDiscoverPolicy(policy);
  const lower = name.toLowerCase();
  for (const [platform, patterns] of Object.entries(platformPatterns)) {
    if (patterns.some((source) => new RegExp(source, "i").test(lower))) return platform;
  }
  return null;
}

export function rankCandidates(
  candidates: RepoCandidate[],
  slug: string,
  platform: string | null,
  policy?: DiscoverPolicyConfig | null | undefined
): RepoCandidate[] {
  const resolved = resolveDiscoverPolicy(policy);
  const suffixes = platform ? (resolved.platformSuffixes[platform] ?? []) : [];
  const scored = candidates
    .filter((candidate) => !resolved.skipArchived || !candidate.isArchived)
    .map((candidate) => {
      const name = repoName(candidate.fullName).toLowerCase();
      let score = 0;
      if (name === slug.toLowerCase()) score += resolved.scores.exact!;
      if (name.startsWith(slug.toLowerCase())) score += resolved.scores.prefix!;
      for (const suffix of suffixes) {
        if (name === `${slug.toLowerCase()}-${suffix}`) score += resolved.scores.suffixExact!;
        else if (name.endsWith(`-${suffix}`)) score += resolved.scores.suffix!;
      }
      if (candidate.description?.toLowerCase().includes(slug.toLowerCase())) score += resolved.scores.description!;
      if (!candidate.isFork) score += resolved.scores.forkBonus!;
      score += Math.min(resolved.starCap, candidate.stars / resolved.starDivisor);
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score || a.candidate.fullName.localeCompare(b.candidate.fullName));
  return scored.map((entry) => entry.candidate);
}

async function ghJson(runner: Runner, gh: string, args: string[], timeoutMs: number): Promise<any | null> {
  const result = await runner(gh, args, { timeoutMs });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export async function githubLogin(
  gh = "gh",
  runner: Runner = runCommand,
  timeoutMs?: number
): Promise<string> {
  const result = await runner(gh, ["api", "user", "--jq", ".login"], {
    timeoutMs: requireTimeoutMs(timeoutMs, "discover timeout")
  });
  if (!result.ok || !result.stdout.trim()) throw new Error("Could not determine the authenticated GitHub user. Run `gh auth login`.");
  return result.stdout.trim();
}

function requireTimeoutMs(value: number | undefined, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} is required (pass discover policy timeouts; run \`auto-work migrate\`)`);
  }
  return value;
}

export async function searchRepos(
  slug: string,
  options: { gh?: string; runner?: Runner; limit?: number; policy?: DiscoverPolicyConfig | null | undefined } = {}
): Promise<RepoCandidate[]> {
  const gh = options.gh ?? "gh";
  const runner = options.runner ?? runCommand;
  const resolved = resolveDiscoverPolicy(options.policy);
  const limit = options.limit ?? resolved.searchLimit;
  const result = await runner(
    gh,
    [
      "search",
      "repos",
      slug,
      "--limit",
      String(limit),
      "--json",
      "fullName,url,description,isFork,isArchived,stargazersCount,updatedAt"
    ],
    { timeoutMs: resolved.timeouts.searchMs }
  );
  if (!result.ok) return [];
  try {
    const data = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    return data
      .filter((item) => typeof item.fullName === "string")
      .map((item) => ({
        fullName: String(item.fullName),
        url: String(item.url ?? `https://github.com/${item.fullName}`),
        sshUrl: typeof item.sshUrl === "string" ? item.sshUrl : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
        isFork: item.isFork === true,
        isArchived: item.isArchived === true,
        stars: Number(item.stargazersCount ?? 0),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined
      }));
  } catch {
    return [];
  }
}

export async function repoInfo(
  fullName: string,
  gh = "gh",
  runner: Runner = runCommand,
  timeoutMs?: number
): Promise<RepoInfo | null> {
  const data = await ghJson(runner, gh, ["api", `repos/${fullName}`], requireTimeoutMs(timeoutMs, "discover api timeout"));
  if (!data) return null;
  return {
    fullName: String(data.full_name ?? fullName),
    cloneUrl: String(data.clone_url ?? `https://github.com/${fullName}.git`),
    sshUrl: typeof data.ssh_url === "string" ? data.ssh_url : undefined,
    defaultBranch: String(data.default_branch ?? "main"),
    isFork: data.fork === true,
    parent: typeof data.parent?.full_name === "string" ? data.parent.full_name : undefined,
    archived: data.archived === true
  };
}

export async function listBranches(
  fullName: string,
  gh = "gh",
  runner: Runner = runCommand,
  timeoutMs?: number
): Promise<string[]> {
  const result = await runner(gh, ["api", `repos/${fullName}/branches`, "--paginate", "--jq", ".[].name"], {
    timeoutMs: requireTimeoutMs(timeoutMs, "discover api timeout")
  });
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function gitProtocol(
  gh = "gh",
  runner: Runner = runCommand,
  timeoutMs?: number
): Promise<"ssh" | "https"> {
  const timeout = requireTimeoutMs(timeoutMs, "discover protocol timeout");
  const attempts = [
    ["config", "get", "git_protocol", "-h", "github.com"],
    ["config", "get", "git_protocol"]
  ];
  for (const args of attempts) {
    const result = await runner(gh, args, { timeoutMs: timeout });
    const value = result.ok ? result.stdout.trim() : "";
    if (value) return value === "ssh" ? "ssh" : "https";
  }
  return "https";
}

export function pickCloneUrl(info: RepoInfo, protocol: "ssh" | "https" = "https"): string {
  if (protocol === "ssh" && info.sshUrl) return info.sshUrl;
  return info.cloneUrl;
}

export async function ensureFork(options: {
  upstream: string;
  user: string;
  createFork: boolean;
  org?: string;
  gh?: string;
  runner?: Runner;
  policy?: DiscoverPolicyConfig | null | undefined;
}): Promise<ForkResult> {
  const gh = options.gh ?? "gh";
  const runner = options.runner ?? runCommand;
  const resolved = resolveDiscoverPolicy(options.policy);
  const upstreamOwner = options.upstream.split("/")[0] ?? "";
  const name = repoName(options.upstream);
  const protocol = await gitProtocol(gh, runner, resolved.timeouts.protocolMs);
  const owner = options.org || options.user;

  if (upstreamOwner.toLowerCase() === owner.toLowerCase()) {
    const info = await repoInfo(options.upstream, gh, runner, resolved.timeouts.apiMs);
    return {
      forkOwner: owner,
      forkRepo: options.upstream,
      forkUrl: info?.cloneUrl ?? `https://github.com/${options.upstream}.git`,
      forkGitUrl: info ? pickCloneUrl(info, protocol) : `https://github.com/${options.upstream}.git`,
      exists: true,
      created: false,
      needsFork: false
    };
  }

  const forkFullName = `${owner}/${name}`;
  let info = await repoInfo(forkFullName, gh, runner, resolved.timeouts.apiMs);
  if (info) {
    return {
      forkOwner: owner,
      forkRepo: forkFullName,
      forkUrl: info.cloneUrl,
      forkGitUrl: pickCloneUrl(info, protocol),
      exists: true,
      created: false,
      needsFork: false
    };
  }

  if (!options.createFork) {
    return {
      forkOwner: owner,
      forkRepo: forkFullName,
      forkUrl: `https://github.com/${forkFullName}.git`,
      forkGitUrl: `https://github.com/${forkFullName}.git`,
      exists: false,
      created: false,
      needsFork: true
    };
  }

  const forkArgs = ["repo", "fork", options.upstream, "--clone=false", "--remote=false"];
  if (options.org) forkArgs.push("--org", options.org);
  const created = await runner(gh, forkArgs, {
    timeoutMs: resolved.timeouts.forkMs
  });
  if (!created.ok) throw new Error(created.stderr || created.stdout || "gh repo fork failed");
  for (let attempt = 0; attempt < resolved.timeouts.forkAttempts && !info; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, resolved.timeouts.forkRetryMs));
    info = await repoInfo(forkFullName, gh, runner, resolved.timeouts.apiMs);
  }
  if (!info) throw new Error(`Fork ${forkFullName} was created but cannot be read yet. Run the command again in a moment.`);
  return {
    forkOwner: options.user,
    forkRepo: forkFullName,
    forkUrl: info.cloneUrl,
    forkGitUrl: pickCloneUrl(info, protocol),
    exists: true,
    created: true,
    needsFork: false
  };
}

export function detectedStackAt(
  dir: string,
  stackMap?: Record<string, string> | null | undefined
): string {
  const map = stackMap ?? {};
  for (const [file, stack] of Object.entries(map)) {
    if (typeof stack !== "string" || !stack) {
      throw new Error("discover.stackMap values must be non-empty strings (run `auto-work migrate`)");
    }
    if (existsSync(path.join(dir, file))) return stack;
  }
  if (!Object.keys(map).length) {
    throw new Error("discover.stackMap is required (run `auto-work migrate`)");
  }
  return "generic";
}

/** Stack → platform via policy (e.g. flutter → desktop, default web). */
export function stackPlatform(
  stack: string,
  policy?: DiscoverPolicyConfig | null | undefined
): string {
  const resolved = resolveDiscoverPolicy(policy);
  return resolved.stackPlatform[stack] ?? resolved.stackPlatformDefault;
}
