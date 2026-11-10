import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_REPAIR_ALLOW_NEW_KEYS, DEFAULT_REPAIR_MUTABLE_PATHS, DEFAULT_REPAIR_STRATEGIES, getConfigPath, setConfigPath, validateConfig, validateConfigPatch, saveConfig } from "./config.js";
import { apiPlatformFilter } from "./ziki.js";
import { parseWorkUrl } from "./ziki-endpoints.js";
import { fillProfileFromTemplates } from "./config-templates.js";
import { mutexFor } from "./mutex.js";
export const PROJECT_NOT_FOUND_MESSAGE = "Project not found.";
/** True only for the retired-project signature — not for any other 404 (e.g. a renamed route). */
export function isProjectNotFoundBlocker(code, message) {
    return code === "platform:not_found" && (message ?? "").includes(PROJECT_NOT_FOUND_MESSAGE);
}
/** Approvals inbox for `auto-work approve` (loop consumes, then truncates). */
export function approvalsFile(profilePaths) {
    return profilePaths.approvalsFile ?? path.join(profilePaths.stateDir, "approvals.json");
}
export async function readLocalApprovals(profilePaths) {
    const file = approvalsFile(profilePaths);
    if (!existsSync(file))
        return [];
    try {
        const raw = JSON.parse(await readFile(file, "utf8"));
        if (!Array.isArray(raw))
            return [];
        return raw.filter((entry) => Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            (entry.decision === "approved" || entry.decision === "rejected"));
    }
    catch {
        return [];
    }
}
export async function consumeLocalApprovals(profilePaths) {
    // Read + truncate must be atomic: the CLI's queueLocalApproval races the
    // loop's consume, and a lost approval is a lost human decision.
    return mutexFor(`approvals:${approvalsFile(profilePaths)}`).run(async () => {
        const approvals = await readLocalApprovals(profilePaths);
        if (!approvals.length)
            return [];
        const file = approvalsFile(profilePaths);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "[]\n", "utf8").catch(() => { });
        return approvals;
    });
}
export async function queueLocalApproval(profilePaths, approval) {
    return mutexFor(`approvals:${approvalsFile(profilePaths)}`).run(async () => {
        const current = await readLocalApprovals(profilePaths);
        const next = [...current.filter((entry) => entry.id !== approval.id), approval];
        const file = approvalsFile(profilePaths);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    });
}
/** Merged repair config: profile values over built-in defaults. */
export function repairConfigFor(profile) {
    const repair = profile.repair ?? {};
    return {
        enabled: repair.enabled ?? true,
        mutablePaths: repair.mutablePaths ?? [...DEFAULT_REPAIR_MUTABLE_PATHS],
        allowNewKeys: repair.allowNewKeys ?? [...DEFAULT_REPAIR_ALLOW_NEW_KEYS],
        strategies: repair.strategies ?? JSON.parse(JSON.stringify(DEFAULT_REPAIR_STRATEGIES))
    };
}
export function strategyFor(profile, code) {
    const repair = repairConfigFor(profile);
    if (!repair.enabled)
        return null;
    const exact = repair.strategies[code];
    if (exact && typeof exact === "object")
        return exact.enabled === false ? null : exact;
    // Wildcard strategies like "*:unknown_filter" match any component.
    const suffix = code.includes(":") ? `*:${code.split(":").slice(1).join(":")}` : null;
    if (suffix) {
        const wildcard = repair.strategies[suffix];
        if (wildcard && typeof wildcard === "object")
            return wildcard.enabled === false ? null : wildcard;
    }
    return null;
}
export function maxRoundsFor(strategy) {
    const rounds = strategy?.maxRounds;
    if (rounds === null || rounds === undefined)
        return 3;
    if (Number.isInteger(rounds) && rounds >= 1)
        return rounds;
    return 3;
}
export function blockerCode(blocker) {
    if (!blocker)
        return null;
    return `${blocker.component}:${blocker.code}`;
}
/**
 * Match a replacement project: exact slug match on the profile platform
 * first, then repo owner/name match as a fallback. Pure function.
 */
export function matchReplacementProject(projects, profile) {
    const slug = profile.ziki.platform?.trim().toLowerCase();
    const slugMatches = slug ? projects.filter((project) => project.slug?.toLowerCase() === slug) : [];
    if (slugMatches.length === 1) {
        return {
            project: slugMatches[0],
            reason: `slug "${slugMatches[0].slug}" matches profile platform "${profile.ziki.platform}"`
        };
    }
    if (slugMatches.length > 1)
        return { ambiguous: slugMatches };
    const repo = githubRepoName(profile.repo.githubRepo);
    const repoMatches = repo
        ? projects.filter((project) => githubRepoName(project.repoUrl) === repo)
        : [];
    if (repoMatches.length === 1) {
        return {
            project: repoMatches[0],
            reason: `repoUrl matches profile repo ${profile.repo.githubRepo}`
        };
    }
    if (repoMatches.length > 1)
        return { ambiguous: repoMatches };
    return null;
}
function githubRepoName(value) {
    if (!value)
        return null;
    const trimmed = value.trim().replace(/\.git$/, "");
    const full = trimmed.match(/github\.com[:/]([^/]+\/[^/]+)$/i);
    if (full)
        return full[1].toLowerCase();
    const bare = trimmed.match(/^([^/]+\/[^/]+)$/);
    return bare ? bare[1].toLowerCase() : null;
}
/**
 * Live diagnosis: list the tenant's projects, match a replacement, read it
 * back and diff every identity field (projectId, projectSlug, orgSlug from
 * workUrl) against the profile. Read-only; proposes only what differs.
 */
export async function diagnoseProjectMismatch(client, profile, logger) {
    const response = await client.listProjects();
    const projects = Array.isArray(response?.items) ? response.items : [];
    logger?.info(`Project lookup: tenant has ${projects.length} project(s)`, {
        slugs: projects.map((project) => project.slug)
    });
    const matched = matchReplacementProject(projects, profile);
    if (!matched || !("project" in matched)) {
        return {
            projects,
            match: null,
            ambiguous: matched && "ambiguous" in matched ? matched.ambiguous : null,
            ops: [],
            unparsedWorkUrl: null,
            detail: matched && "ambiguous" in matched
                ? `multiple tenant projects match; need a human pick: ${matched.ambiguous.map((project) => project.slug).join(", ")}`
                : `no tenant project matches platform "${profile.ziki.platform}" or repo "${profile.repo.githubRepo}"`
        };
    }
    const project = matched.project;
    let work = null;
    let rawWorkUrl = null;
    try {
        const full = await client.readProject(project.id);
        if (typeof full?.workUrl === "string" && full.workUrl) {
            rawWorkUrl = full.workUrl;
            work = parseWorkUrl(full.workUrl);
        }
    }
    catch (error) {
        logger?.warn(`Project read failed for ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const ops = [];
    if (profile.ziki.projectId !== project.id) {
        ops.push({ path: "ziki.projectId", value: project.id, reason: matched.reason });
    }
    if (profile.ziki.projectSlug !== project.slug) {
        ops.push({ path: "ziki.projectSlug", value: project.slug, reason: `tenant project slug is "${project.slug}"` });
    }
    if (work?.org && profile.ziki.orgSlug !== work.org) {
        ops.push({ path: "ziki.orgSlug", value: work.org, reason: `project workUrl lives under org "${work.org}"` });
    }
    if (work && work.project !== project.slug) {
        logger?.warn(`Project slug mismatch: list says "${project.slug}" but workUrl points at "${work.project}"`);
    }
    // Unrecognized address shape: do NOT guess org/project from it. The match
    // above still lets the agent propose identity fields it can see, but a
    // human must confirm the addressing before anything applies.
    const unparsedWorkUrl = !work && rawWorkUrl ? rawWorkUrl : null;
    if (unparsedWorkUrl) {
        logger?.warn(`Unrecognized project URL shape (needs human confirmation): ${unparsedWorkUrl}`);
    }
    return {
        projects,
        match: { project, reason: matched.reason },
        ambiguous: null,
        ops,
        unparsedWorkUrl,
        detail: ops.length
            ? `Project ${profile.ziki.projectId} is gone on Ziki; matched replacement ${project.slug} (${matched.reason}).` +
                (unparsedWorkUrl
                    ? ` NOTE: the project's address format is unrecognized (${unparsedWorkUrl}) — confirm the project URL shape with a human before approving.`
                    : "")
            : `Project identity already matches tenant project ${project.slug}; no rotation needed.`
    };
}
/**
 * Deterministic missing-key repair: diff the live profile against init
 * templates (the same fill `migrate`/`loadProfile` apply) and propose
 * exactly the absent paths. No agent needed; the human approves the values.
 */
export function diagnoseMissingKeys(profile, templates) {
    const { profile: filledProfile, filled: filledPaths } = fillProfileFromTemplates(profile, templates);
    const repair = repairConfigFor(filledProfile);
    const ops = [];
    const dropped = [];
    for (const path of filledPaths) {
        const op = {
            path,
            value: getConfigPath(filledProfile, path),
            reason: "absent from config; value from init templates (last-known-good — verify against Ziki before approving)"
        };
        // Keep only ops the allowlist accepts: protected paths (repo identity,
        // executors, statuses semantics) stay a manual human edit, never an
        // agent proposal — even a deterministic one.
        if (validateConfigPatch(filledProfile, [op], repair).ok)
            ops.push(op);
        else
            dropped.push(path);
    }
    return {
        ops,
        summary: ops.length
            ? `Config is missing ${ops.length} templated value(s): ${ops.map((op) => op.path).join(",")}${dropped.length ? ` (${dropped.length} protected path(s) need a manual edit: ${dropped.join(", ")})` : ""}.`
            : dropped.length
                ? `Only protected paths are missing (${dropped.join(", ")}); edit the config manually.`
                : "Profile already matches init templates; the failure needs a human look."
    };
}
/**
 * Deterministic unknown-kind repair: a Ziki work kind the queue has never
 * seen. Proposed into the aux bucket with priority after every known kind
 * (visible, never silently dropped); the human moves it to owner/work/review
 * if triage says otherwise.
 */
export function diagnoseUnknownKind(kind, profile) {
    const priorities = profile.queue?.priorities ?? {};
    const maxKnown = Math.max(0, ...Object.values(priorities).filter((value) => typeof value === "number"));
    const buckets = profile.queue?.buckets;
    const aux = Array.isArray(buckets?.aux) ? [...buckets.aux] : [];
    const ops = [
        {
            path: `queue.priorities.${kind}`,
            value: maxKnown + 1,
            reason: `new Ziki kind "${kind}" sorts after every known kind until triaged`
        }
    ];
    if (!aux.includes(kind)) {
        ops.push({
            path: "queue.buckets.aux",
            value: [...aux, kind],
            reason: `new Ziki kind "${kind}" is queued as auxiliary work (move buckets if triage says otherwise)`
        });
    }
    return {
        ops,
        summary: `Ziki reports work kind "${kind}", which no bucket or priority covers.`
    };
}
/**
 * Deterministic unknown-vocabulary repair: append unseen Ziki statuses or
 * substatuses to statuses.known ONLY (drift vocabulary — never redefines
 * what counts as done; workable/terminal lists stay human-owned).
 */
export function diagnoseUnknownVocabulary(values, profile) {
    const known = profile.statuses?.known;
    if (!Array.isArray(known)) {
        return { ops: [], summary: "statuses.known is not configured; run `auto-work migrate` first." };
    }
    const unseen = [...new Set(values.filter((value) => typeof value === "string" && value && !known.includes(value)))];
    if (!unseen.length) {
        return { ops: [], summary: "Unknown values already recorded in statuses.known; nothing to propose." };
    }
    return {
        ops: [
            {
                path: "statuses.known",
                value: [...known, ...unseen],
                reason: `record Ziki drift vocabulary (${unseen.join(", ")}) so the warning clears; done-ness untouched`
            }
        ],
        summary: `Ziki uses vocabulary outside statuses.known: ${unseen.join(", ")}.`
    };
}
/**
 * Deterministic unknown-endpoint repair: an operations entry points at an
 * endpoint name missing from ziki.endpoints. If init templates know that
 * endpoint (config drift), propose the template value. If templates don't
 * know it either, Ziki added a route: no deterministic ops here (guessing
 * routes is never deterministic) — the config-doctor proposes from the
 * live llms.txt evidence instead, and the human APPROVE gate admits it.
 */
export function diagnoseUnknownEndpoint(group, name, profile, templates) {
    const templateEndpoints = templates.endpoints;
    const templateValue = templateEndpoints?.[group]?.[name];
    if (typeof templateValue !== "string" || !templateValue) {
        return {
            ops: [],
            summary: `Endpoint ${group}.${name} is in neither the profile nor init templates — ` +
                "Ziki likely added a route. Add ziki.endpoints + operations entries manually, then re-run."
        };
    }
    const ops = [
        {
            path: `ziki.endpoints.${group}.${name}`,
            value: templateValue,
            reason: `endpoint known from init templates (config drift, not a Ziki change)`
        }
    ];
    const templateOps = templates.operations;
    const opTemplate = templateOps?.[group]?.[name];
    const existingOp = profile.operations?.[group]?.[name];
    if (opTemplate && typeof opTemplate === "object" && existingOp === undefined) {
        ops.push({
            path: `operations.${group}.${name}`,
            value: JSON.parse(JSON.stringify(opTemplate)),
            reason: "operation contract known from init templates (config drift)"
        });
    }
    return {
        ops,
        summary: `Endpoint ${group}.${name} is missing from ziki.endpoints but known from init templates.`
    };
}
const UNKNOWN_ENDPOINT_PATTERN = /unknown (?:endpoint|operation): ([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/;
/** Parse "unknown endpoint: group.name" / "unknown operation: group.name" from a blocker message. */
export function parseUnknownEndpoint(message) {
    if (!message)
        return null;
    const match = message.match(UNKNOWN_ENDPOINT_PATTERN);
    if (!match)
        return null;
    return { group: match[1], name: match[2] };
}
/**
 * Diagnose an unknown platform/area filter: list the tenant's current
 * platforms and see whether the configured filter still resolves. Read-only.
 * Shapes are defensive — the endpoint is newer than any pinned contract.
 */
export async function diagnoseUnknownFilter(client, profile, logger) {
    const current = apiPlatformFilter(profile);
    let raw = null;
    try {
        raw = await client.platforms();
    }
    catch (error) {
        return {
            platforms: [],
            current,
            resolves: false,
            suggested: [],
            reason: `platform list unreadable: ${error instanceof Error ? error.message : String(error)}`
        };
    }
    const items = Array.isArray(raw?.items)
        ? (raw.items ?? [])
        : Array.isArray(raw?.platforms)
            ? (raw.platforms ?? [])
            : Array.isArray(raw)
                ? raw
                : [];
    const platforms = items.map((item) => ({
        slug: typeof item.slug === "string" ? item.slug : null,
        name: typeof item.name === "string" ? item.name : null
    }));
    const slugs = new Set(platforms.map((platform) => platform.slug).filter(Boolean));
    logger?.info("Platform filter check", { current, slugs: [...slugs] });
    if (current && slugs.has(current)) {
        return { platforms, current, resolves: true, suggested: [], reason: `filter "${current}" still resolves` };
    }
    if (slugs.has(profile.ziki.platform)) {
        return {
            platforms,
            current,
            resolves: false,
            suggested: [
                {
                    path: "ziki.platformFilter",
                    value: profile.ziki.platform,
                    reason: `custom filter "${current ?? "(omitted)"}" is unknown; identity "${profile.ziki.platform}" still resolves`
                }
            ],
            reason: `filter "${current ?? "(omitted)"}" unknown; identity resolves`
        };
    }
    if (slugs.size === 1) {
        const only = [...slugs][0];
        return {
            platforms,
            current,
            resolves: false,
            suggested: [
                {
                    path: "ziki.platformFilter",
                    value: only,
                    reason: `custom filter "${current ?? "(omitted)"}" is unknown; tenant has a single platform "${only}"`
                }
            ],
            reason: "single tenant platform"
        };
    }
    return {
        platforms,
        current,
        resolves: false,
        suggested: [],
        reason: `filter "${current ?? "(omitted)"}" unknown and no unambiguous replacement among ${slugs.size} platforms`
    };
}
/**
 * Validate and persist an approved patch: allowlist check, type check, full
 * config validation on the merged result, timestamped backup, atomic save.
 * Pure file operation — never touches Ziki or agents.
 */
export async function applyConfigPatch(config, profileName, profilePaths, ops, logger) {
    const rawProfile = config.profiles?.[profileName];
    if (!rawProfile || typeof rawProfile !== "object") {
        return { ok: false, errors: [`profile "${profileName}" not found in config`] };
    }
    const { loadProfile } = await import("./config.js");
    const before = await loadProfile(profileName);
    const repair = repairConfigFor(before.profile);
    const patchCheck = validateConfigPatch(before.profile, ops, repair);
    if (!patchCheck.ok)
        return { ok: false, errors: patchCheck.errors };
    const next = JSON.parse(JSON.stringify(config));
    for (const op of ops) {
        // Re-resolve the target from the accumulating `next` object on every
        // iteration: setConfigPath returns a fresh clone, so holding a stale
        // reference would silently drop every op but the last per section.
        const currentRaw = next.profiles[profileName];
        const currentDefaults = (next.defaults ?? {});
        const root = op.path.split(".")[0];
        const target = root in currentRaw ? currentRaw : root in currentDefaults ? currentDefaults : currentRaw;
        const updated = setConfigPath(target, op.path, op.value);
        if (target === currentRaw)
            next.profiles[profileName] = updated;
        else
            next.defaults = updated;
    }
    const validation = validateConfig({ ...next, activeProfile: profileName, profiles: { [profileName]: next.profiles[profileName] } });
    if (!validation.ok)
        return { ok: false, errors: validation.errors };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = `${profilePaths.stateDir}/config.backup-${stamp}.json`;
    await mkdir(path.dirname(backupFile), { recursive: true });
    await copyFile((await import("./platform/paths.js")).paths().configFile, backupFile).catch(() => { });
    // Never report a backup path that does not exist: the copy above is
    // best-effort (disk full, permissions), so check before claiming it.
    const backupOk = existsSync(backupFile);
    if (!backupOk) {
        logger?.warn(`Config backup copy failed; proceeding without a backup at ${backupFile}`);
    }
    await saveConfig(next);
    // Read-back verification: the record must never overstate reality. Re-read
    // the persisted config and confirm every op path holds the patched value
    // (guards against partial writes, stale-reference bugs, and races).
    const readBack = await verifyPersistedPatch(profileName, ops, logger);
    if (!readBack.ok)
        return { ok: false, errors: readBack.errors };
    logger?.info(`Config patch applied (${ops.length} op(s))${backupOk ? `, backup ${backupFile}` : " (no backup)"}`, {
        ops: ops.map((op) => op.path)
    });
    return { ok: true, ...(backupOk ? { backupFile } : {}) };
}
/**
 * Re-read the persisted config file and confirm every op path holds the
 * expected value. Returns the mismatches, if any — the caller must treat a
 * mismatch as a failed apply, never as "applied".
 */
export async function verifyPersistedPatch(profileName, ops, logger) {
    const { paths } = await import("./platform/paths.js");
    let raw;
    try {
        raw = JSON.parse(await readFile(paths().configFile, "utf8"));
    }
    catch (error) {
        return { ok: false, errors: [`could not re-read config for verification: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const stored = raw?.profiles?.[profileName];
    const defaults = raw?.defaults;
    const errors = [];
    for (const op of ops) {
        const root = op.path.split(".")[0];
        const holder = stored && typeof stored === "object" && root in stored
            ? stored
            : defaults;
        const actual = getConfigPath(holder, op.path);
        if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
            errors.push(`read-back mismatch for ${op.path}: expected ${JSON.stringify(op.value)}, found ${JSON.stringify(actual)}`);
        }
    }
    if (errors.length) {
        logger?.warn(`Config patch verification failed (${errors.length} mismatch(es))`, { errors });
        return { ok: false, errors };
    }
    return { ok: true };
}
/** Escalation body for a config-repair proposal. */
export function formatRepairEscalationBody(options) {
    const lines = [
        `[config repair · ${options.strategy}] ${options.failureMessage}`,
        "",
        options.summary,
        "",
        "Proposed config patch (applies automatically on approval):",
        ...options.ops.map((op) => `- \`${op.path}\` → ${JSON.stringify(op.value)}${op.reason ? ` — ${op.reason}` : ""}`),
        ""
    ];
    if (options.evidence.length) {
        lines.push("Evidence:", ...options.evidence.map((line) => `- ${line}`), "");
    }
    if (options.previousAnswer) {
        lines.push(`Your last reply (not an approval — revising): ${options.previousAnswer}`, "");
    }
    lines.push(`Round ${options.round}. Reply starting with APPROVE to apply the patch and resume the loop.`, "Anything else keeps this open and triggers a revised proposal.");
    return lines.join("\n").slice(0, 2000);
}
/** Latest open config escalation for a strategy (reaps local CLI approvals first). */
export function latestStrategyEscalation(state, strategy) {
    const open = Object.values(state.escalations)
        .filter((escalation) => (escalation.kind ?? "issue") === "config" &&
        escalation.strategy === strategy &&
        escalation.status === "open")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return open[0] ?? null;
}
/**
 * Latest config escalation for a strategy regardless of status. The open-only
 * lookup above cannot see terminal answers (rejected/dismissed/expired), so
 * without this a rejection is silently re-proposed next cycle as if the
 * human had never answered.
 */
export function latestStrategyEscalationAny(state, strategy) {
    const all = Object.values(state.escalations)
        .filter((escalation) => (escalation.kind ?? "issue") === "config" &&
        escalation.strategy === strategy)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all[0] ?? null;
}
/**
 * Supersede check: returns the newly covered paths when the fresh diagnosis is
 * a strict superset of the pending proposal (monotonic growth guarantees the
 * escalation chain terminates), else null. Pure function — extracted for testing.
 */
export function supersedingPaths(existing, fresh) {
    if (!fresh?.length)
        return null;
    const pending = new Set((existing ?? []).map((op) => op.path));
    const covers = new Set(fresh.map((op) => op.path));
    const extra = [...covers].filter((path) => !pending.has(path));
    if ([...pending].every((path) => covers.has(path)) && extra.length)
        return extra;
    return null;
}
//# sourceMappingURL=config-repair.js.map