import type { Config, ProfileConfig } from "./types.js";
export interface InitTemplates {
    _meta?: {
        configVersion?: number;
        source?: string;
        note?: string;
    };
    [section: string]: unknown;
}
export declare function initTemplatesPath(): string;
export declare function loadInitTemplates(): Promise<InitTemplates>;
/** Synchronous variant for tests that pre-load via loadInitTemplates first. */
export declare function getCachedTemplates(): InitTemplates | null;
/**
 * Synchronous template load for sync call sites (defaultConfig, patch
 * validation). Same file, same data as the async loader; result is cached.
 */
export declare function loadInitTemplatesSync(): InitTemplates;
export declare function templateVersion(templates: InitTemplates): number;
/**
 * Fill every missing top-level section of a profile from init templates.
 * Returns the filled profile plus the list of dot-paths that were filled
 * (for migration notes and --explain provenance). Never overwrites explicit
 * values. Sections present in templates: limits, workflow, prTracking,
 * timing, statuses, health, repair, transport, operations, queue, reviewGate,
 * heartbeatPolicy, decisions, noop, votes, idea, apiRepair, capacity, urls,
 * discover, github, safety, checksDefaults, outbox, bootstrap, offline, loop,
 * pr, repo, discovery, pollSeconds, memoryRefreshMinutes, hitl, executor, envFiles.
 */
export declare function fillProfileFromTemplates(profile: ProfileConfig, templates: InitTemplates): {
    profile: ProfileConfig;
    filled: string[];
};
/**
 * Migrate a v3 config object to v4: stamp version 4 and fill every profile
 * (and defaults) from init templates. Reports filled paths per profile.
 * The caller handles backup + write.
 */
export declare function migrateV3toV4(config: Config, templates: InitTemplates): {
    config: Config;
    filled: Record<string, string[]>;
};
export interface ExplainEntry {
    path: string;
    source: "explicit" | "template" | "missing";
    detail?: string;
}
/**
 * Provenance for --explain: for each v4 section, whether the merged profile
 * sets it explicitly, and which profile-level keys are still missing.
 */
export declare function explainProfile(profileName: string, rawProfile: Record<string, unknown>, templates: InitTemplates): ExplainEntry[];
