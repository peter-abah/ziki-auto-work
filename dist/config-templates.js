import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "./platform/paths.js";
let cached = null;
export function initTemplatesPath() {
    return path.join(PACKAGE_ROOT, "config", "init-templates.json");
}
export async function loadInitTemplates() {
    if (cached)
        return cached;
    const raw = await readFile(initTemplatesPath(), "utf8");
    cached = JSON.parse(raw);
    return cached;
}
/** Synchronous variant for tests that pre-load via loadInitTemplates first. */
export function getCachedTemplates() {
    return cached;
}
/**
 * Synchronous template load for sync call sites (defaultConfig, patch
 * validation). Same file, same data as the async loader; result is cached.
 */
export function loadInitTemplatesSync() {
    if (cached)
        return cached;
    const raw = readFileSync(initTemplatesPath(), "utf8");
    cached = JSON.parse(raw);
    return cached;
}
export function templateVersion(templates) {
    const version = Number(templates._meta?.configVersion);
    return Number.isFinite(version) ? version : 4;
}
function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}
function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Sections where nested keys fill from templates when absent (additive
 * policy lists). Only template-known keys ever fill, so identity sections
 * stay untouched. Excluded: operations/endpoints/ziki — maps where a
 * missing key may be an intentional removal.
 */
const NESTED_FILL_SECTIONS = new Set([
    "limits",
    "workflow",
    "prTracking",
    "timing",
    "statuses",
    "health",
    "repo",
    "pr",
    "discovery",
    "decisions",
    "queue",
    "reviewGate",
    "heartbeatPolicy",
    "noop",
    "votes",
    "idea",
    "apiRepair",
    "capacity",
    "urls",
    "discover",
    "github",
    "safety",
    "checksDefaults",
    "outbox",
    "bootstrap",
    "offline",
    "loop",
    "pr",
    "transport",
    "timing",
    "health",
    "repair",
    "hitl",
    "executor"
]);
function deepFillMissing(target, template, filled, prefix, root) {
    for (const [key, templateValue] of Object.entries(template)) {
        const current = target[key];
        if (current === undefined) {
            target[key] = clone(templateValue);
            filled.push(`${prefix}.${key}`);
        }
        else if (NESTED_FILL_SECTIONS.has(root) && isPlainRecord(current) && isPlainRecord(templateValue)) {
            deepFillMissing(current, templateValue, filled, `${prefix}.${key}`, root);
        }
    }
}
/**
 * Fill every missing top-level section of a profile from init templates.
 * Returns the filled profile plus the list of dot-paths that were filled
 * (for migration notes and --explain provenance). Never overwrites explicit
 * values. Sections present in templates: limits, workflow, prTracking,
 * timing, statuses, repair, transport, operations, queue, reviewGate,
 * heartbeatPolicy, decisions, noop, votes, idea, apiRepair, capacity, urls,
 * discover, github, safety, checksDefaults, outbox, bootstrap, offline, loop, envFiles.
 */
export function fillProfileFromTemplates(profile, templates) {
    const filled = [];
    const out = clone(profile);
    const templateSections = {
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
        offline: "offline",
        loop: "loop",
        pr: "pr",
        repo: "repo",
        discovery: "discovery",
        pollSeconds: "pollSeconds",
        memoryRefreshMinutes: "memoryRefreshMinutes",
        hitl: "hitl",
        // executor is merged, not replaced: only timeout/permission defaults fill in.
        executor: "executor"
    };
    for (const [profileKey, templateKey] of Object.entries(templateSections)) {
        if (out[profileKey] === undefined && templates[templateKey] !== undefined) {
            out[profileKey] = clone(templates[templateKey]);
            filled.push(profileKey);
            continue;
        }
        // Present sections in the nested-fill set gain missing nested keys
        // (additive policy lists). Anything explicit is never overwritten.
        const current = out[profileKey];
        const templateValue = templates[templateKey];
        if (isPlainRecord(current) && isPlainRecord(templateValue)) {
            deepFillMissing(current, templateValue, filled, profileKey, profileKey);
        }
    }
    // ziki.endpoints lives nested; fill when absent (a pre-endpoints v3
    // profile has no endpoint registry at all — without this every call 404s
    // through the unknown-endpoint path).
    const ziki = out.ziki;
    if (ziki && ziki.endpoints === undefined && templates.endpoints !== undefined) {
        ziki.endpoints = clone(templates.endpoints);
        filled.push("ziki.endpoints");
    }
    // repo.envFiles lives nested; fill when absent.
    const repo = out.repo;
    if (repo && repo.envFiles === undefined && Array.isArray(templates.envFiles)) {
        repo.envFiles = clone(templates.envFiles);
        filled.push("repo.envFiles");
    }
    return { profile: out, filled };
}
/**
 * Migrate a v3 config object to v4: stamp version 4 and fill every profile
 * (and defaults) from init templates. Reports filled paths per profile.
 * The caller handles backup + write.
 */
export function migrateV3toV4(config, templates) {
    const filled = {};
    const next = clone(config);
    next.version = 4;
    const defaults = (next.defaults ?? {});
    const filledDefaults = fillProfileFromTemplates(defaults, templates);
    next.defaults = filledDefaults.profile;
    if (filledDefaults.filled.length)
        filled["defaults"] = filledDefaults.filled;
    for (const [name, rawProfile] of Object.entries(next.profiles ?? {})) {
        const result = fillProfileFromTemplates(rawProfile, templates);
        next.profiles[name] = result.profile;
        if (result.filled.length)
            filled[`profiles.${name}`] = result.filled;
    }
    return { config: next, filled };
}
/**
 * Provenance for --explain: for each v4 section, whether the merged profile
 * sets it explicitly, and which profile-level keys are still missing.
 */
export function explainProfile(profileName, rawProfile, templates) {
    const entries = [];
    const sections = [
        "limits", "workflow", "prTracking", "timing", "statuses", "repair",
        "transport", "operations", "queue", "reviewGate", "heartbeatPolicy",
        "decisions", "noop", "votes", "idea", "apiRepair", "capacity", "urls",
        "discover", "github", "safety", "checksDefaults", "outbox", "bootstrap", "loop", "offline", "pr",
        "repo", "discovery",
        "pollSeconds", "memoryRefreshMinutes", "hitl", "executor", "endpoints"
    ];
    // "endpoints" above is display-only: the real fill targets ziki.endpoints
    // (handled separately above), never a top-level key.
    for (const section of sections) {
        if (section === "endpoints") {
            const nested = rawProfile.ziki?.endpoints;
            entries.push({
                path: `profiles.${profileName}.ziki.endpoints`,
                source: nested !== undefined ? "explicit" : "template",
                detail: nested !== undefined ? undefined : "would fill from init-templates.json (v4) on migrate"
            });
            continue;
        }
        if (rawProfile[section] !== undefined) {
            entries.push({ path: `profiles.${profileName}.${section}`, source: "explicit" });
        }
        else if (templates[section] !== undefined) {
            entries.push({
                path: `profiles.${profileName}.${section}`,
                source: "template",
                detail: `would fill from init-templates.json (v${templateVersion(templates)}) on migrate`
            });
        }
        else {
            entries.push({ path: `profiles.${profileName}.${section}`, source: "missing" });
        }
    }
    return entries;
}
//# sourceMappingURL=config-templates.js.map