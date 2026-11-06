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
/**
 * Fill every missing top-level section of a profile from init templates.
 * Returns the filled profile plus the list of dot-paths that were filled
 * (for migration notes and --explain provenance). Never overwrites explicit
 * values. Sections present in templates: limits, workflow, prTracking,
 * timing, statuses, repair, transport, operations, queue, reviewGate,
 * heartbeatPolicy, decisions, noop, votes, idea, apiRepair, capacity, urls,
 * discover, github, safety, checksDefaults, outbox, bootstrap, loop, envFiles.
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
        loop: "loop",
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
        }
    }
    // executor is provider-chosen by the wizard; only the behavioral knobs fill
    // from templates when the wizard leaves them absent.
    const executor = out.executor;
    const templateExecutor = templates.executor;
    if (executor && templateExecutor) {
        for (const key of ["timeoutMs", "permissionMode"]) {
            if (executor[key] === undefined && templateExecutor[key] !== undefined) {
                executor[key] = clone(templateExecutor[key]);
                filled.push(`executor.${key}`);
            }
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
        "discover", "github", "safety", "checksDefaults", "outbox", "bootstrap", "loop",
        "pollSeconds", "memoryRefreshMinutes", "hitl", "executor", "endpoints"
    ];
    // "endpoints" above is display-only: the real fill targets ziki.endpoints
    // (handled separately above), never a top-level key.
    for (const section of sections) {
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