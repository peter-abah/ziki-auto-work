import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_REPAIR_ALLOW_NEW_KEYS, DEFAULT_REPAIR_MUTABLE_PATHS, DEFAULT_REPAIR_STRATEGIES, setConfigPath, validateConfig, validateConfigPatch, saveConfig } from "./config.js";
import { apiPlatformFilter } from "./ziki.js";
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
    const approvals = await readLocalApprovals(profilePaths);
    if (!approvals.length)
        return [];
    const file = approvalsFile(profilePaths);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "[]\n", "utf8").catch(() => { });
    return approvals;
}
export async function queueLocalApproval(profilePaths, approval) {
    const current = await readLocalApprovals(profilePaths);
    const next = [...current.filter((entry) => entry.id !== approval.id), approval];
    const file = approvalsFile(profilePaths);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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
/** Live diagnosis: list the tenant's projects and match a replacement. Read-only. */
export async function diagnoseProjectMismatch(client, profile, logger) {
    const response = await client.listProjects();
    const projects = Array.isArray(response?.items) ? response.items : [];
    logger?.info(`Project lookup: tenant has ${projects.length} project(s)`, {
        slugs: projects.map((project) => project.slug)
    });
    const matched = matchReplacementProject(projects, profile);
    if (matched && "project" in matched) {
        return { projects, match: { project: matched.project, reason: matched.reason }, ambiguous: null };
    }
    return { projects, match: null, ambiguous: matched && "ambiguous" in matched ? matched.ambiguous : null };
}
/** Build the patch ops for adopting a replacement project. */
export function projectRotationPatch(project, reason) {
    return [{ path: "ziki.projectId", value: project.id, reason }];
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
    const nextRaw = next.profiles[profileName];
    const nextDefaults = (next.defaults ?? {});
    for (const op of ops) {
        // Prefer the raw profile section; fall back to defaults when the top-level
        // key only lives there. New keys land in the raw profile section.
        const root = op.path.split(".")[0];
        const target = root in nextRaw ? nextRaw : root in nextDefaults ? nextDefaults : nextRaw;
        const updated = setConfigPath(target, op.path, op.value);
        if (target === nextRaw)
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
    await saveConfig(next);
    logger?.info(`Config patch applied (${ops.length} op(s)), backup ${backupFile}`, {
        ops: ops.map((op) => op.path)
    });
    return { ok: true, backupFile };
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
//# sourceMappingURL=config-repair.js.map