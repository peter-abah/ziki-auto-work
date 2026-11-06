import { readFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "./platform/paths.js";
import type { Config, ProfileConfig } from "./types.js";

export interface InitTemplates {
  _meta?: { configVersion?: number; source?: string; note?: string };
  [section: string]: unknown;
}

let cached: InitTemplates | null = null;

export function initTemplatesPath(): string {
  return path.join(PACKAGE_ROOT, "config", "init-templates.json");
}

export async function loadInitTemplates(): Promise<InitTemplates> {
  if (cached) return cached;
  const raw = await readFile(initTemplatesPath(), "utf8");
  cached = JSON.parse(raw) as InitTemplates;
  return cached;
}

/** Synchronous variant for tests that pre-load via loadInitTemplates first. */
export function getCachedTemplates(): InitTemplates | null {
  return cached;
}

export function templateVersion(templates: InitTemplates): number {
  const version = Number(templates._meta?.configVersion);
  return Number.isFinite(version) ? version : 4;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/**
 * Fill every missing top-level section of a profile from init templates.
 * Returns the filled profile plus the list of dot-paths that were filled
 * (for migration notes and --explain provenance). Never overwrites explicit
 * values. Sections present in templates: limits, workflow, prTracking,
 * timing, statuses, repair, transport, operations, queue, reviewGate,
 * heartbeatPolicy, decisions, noop, votes, idea, apiRepair, capacity, urls,
 * discover, github, safety, checksDefaults, outbox, bootstrap, loop, envFiles.
 */
export function fillProfileFromTemplates(
  profile: ProfileConfig,
  templates: InitTemplates
): { profile: ProfileConfig; filled: string[] } {
  const filled: string[] = [];
  const out = clone(profile) as unknown as Record<string, unknown>;
  const templateSections: Record<string, string> = {
    limits: "limits",
    workflow: "workflow",
    prTracking: "prTracking",
    timing: "timing",
    statuses: "statuses",
    repair: "repair",
    transport: "transport",
    operations: "operations",
    queue: "queue",
    reviewGate: "reviewGate",
    heartbeatPolicy: "heartbeatPolicy",
    decisions: "decisions",
    noop: "noop",
    votes: "votes",
    idea: "idea",
    apiRepair: "apiRepair",
    capacity: "capacity",
    urls: "urls",
    discover: "discover",
    github: "github",
    safety: "safety",
    checksDefaults: "checksDefaults",
    outbox: "outbox",
    bootstrap: "bootstrap",
    loop: "loop"
  };
  for (const [profileKey, templateKey] of Object.entries(templateSections)) {
    if (out[profileKey] === undefined && templates[templateKey] !== undefined) {
      out[profileKey] = clone(templates[templateKey]);
      filled.push(profileKey);
    }
  }
  // repo.envFiles lives nested; fill when absent.
  const repo = out.repo as Record<string, unknown> | undefined;
  if (repo && repo.envFiles === undefined && Array.isArray(templates.envFiles)) {
    repo.envFiles = clone(templates.envFiles);
    filled.push("repo.envFiles");
  }
  return { profile: out as unknown as ProfileConfig, filled };
}

/**
 * Migrate a v3 config object to v4: stamp version 4 and fill every profile
 * (and defaults) from init templates. Reports filled paths per profile.
 * The caller handles backup + write.
 */
export function migrateV3toV4(
  config: Config,
  templates: InitTemplates
): { config: Config; filled: Record<string, string[]> } {
  const filled: Record<string, string[]> = {};
  const next = clone(config);
  next.version = 4;
  const defaults = (next.defaults ?? {}) as unknown as ProfileConfig;
  const filledDefaults = fillProfileFromTemplates(defaults, templates);
  next.defaults = filledDefaults.profile as unknown as typeof next.defaults;
  if (filledDefaults.filled.length) filled["defaults"] = filledDefaults.filled;
  for (const [name, rawProfile] of Object.entries(next.profiles ?? {})) {
    const result = fillProfileFromTemplates(rawProfile as ProfileConfig, templates);
    (next.profiles as Record<string, unknown>)[name] = result.profile;
    if (result.filled.length) filled[`profiles.${name}`] = result.filled;
  }
  return { config: next, filled };
}

export interface ExplainEntry {
  path: string;
  source: "explicit" | "template" | "missing";
  detail?: string;
}

/**
 * Provenance for --explain: for each v4 section, whether the merged profile
 * sets it explicitly, and which profile-level keys are still missing.
 */
export function explainProfile(
  profileName: string,
  rawProfile: Record<string, unknown>,
  templates: InitTemplates
): ExplainEntry[] {
  const entries: ExplainEntry[] = [];
  const sections = [
    "limits", "workflow", "prTracking", "timing", "statuses", "repair",
    "transport", "operations", "queue", "reviewGate", "heartbeatPolicy",
    "decisions", "noop", "votes", "idea", "apiRepair", "capacity", "urls",
    "discover", "github", "safety", "checksDefaults", "outbox", "bootstrap", "loop"
  ];
  for (const section of sections) {
    if (rawProfile[section] !== undefined) {
      entries.push({ path: `profiles.${profileName}.${section}`, source: "explicit" });
    } else if (templates[section] !== undefined) {
      entries.push({
        path: `profiles.${profileName}.${section}`,
        source: "template",
        detail: `would fill from init-templates.json (v${templateVersion(templates)}) on migrate`
      });
    } else {
      entries.push({ path: `profiles.${profileName}.${section}`, source: "missing" });
    }
  }
  return entries;
}
