import { loadProfile } from "./config.js";
import { apiPlatformFilter, clientForAgent } from "./ziki.js";
/**
 * Morning/evening Ziki drift review, machine-checked: re-reads the live
 * tenant (platforms, project identity) and diffs it against the merged
 * profile. Read-only; findings tell the human (or the repair flow) exactly
 * what to update. Never writes config.
 */
export async function runDriftCheck(profileName) {
    const findings = [];
    const add = (name, ok, detail) => {
        findings.push({ name, ok, detail });
    };
    let loaded;
    try {
        loaded = await loadProfile(profileName);
    }
    catch (error) {
        return { ok: false, findings: [{ name: "profile", ok: false, detail: error instanceof Error ? error.message : String(error) }] };
    }
    const { profile, keys } = loaded;
    const agent = keys.workers[0] ?? keys.managers[0];
    if (!agent) {
        return { ok: false, findings: [{ name: "keys", ok: false, detail: "no usable agent keys" }] };
    }
    const client = clientForAgent(agent, profile);
    let projects = [];
    try {
        const response = await client.listProjects();
        projects = Array.isArray(response?.items) ? response.items : [];
        add("projects.list", true, `${projects.length} tenant project(s)`);
    }
    catch (error) {
        add("projects.list", false, error instanceof Error ? error.message : String(error));
        return { ok: false, findings };
    }
    const ids = new Set(projects.map((project) => String(project.id ?? "")));
    if (ids.has(profile.ziki.projectId)) {
        add("project identity", true, `${profile.ziki.projectSlug} (${profile.ziki.projectId}) still exists`);
    }
    else {
        const slugs = projects.map((project) => String(project.slug ?? "?")).join(", ");
        add("project identity", false, `configured project ${profile.ziki.projectId} is gone from the tenant (have: ${slugs || "(none)"}) — run the platform:not_found repair`);
    }
    try {
        const platforms = await client.platforms();
        const items = Array.isArray(platforms?.items)
            ? (platforms.items ?? [])
            : [];
        const slugs = new Set(items.map((item) => String(item.slug ?? "")).filter(Boolean));
        const filter = apiPlatformFilter(profile);
        if (!filter) {
            add("platform filter", true, "no platform filter configured (unfiltered)");
        }
        else if (slugs.has(filter)) {
            add("platform filter", true, `"${filter}" still resolves (${slugs.size} platform(s): ${[...slugs].join(", ")})`);
        }
        else {
            add("platform filter", false, `filter "${filter}" resolves nowhere (tenant has: ${[...slugs].join(", ") || "(none)"}) — run the *:unknown_filter repair`);
        }
    }
    catch (error) {
        add("platforms.list", false, error instanceof Error ? error.message : String(error));
    }
    return { ok: findings.every((finding) => finding.ok), findings };
}
export function formatDrift(result) {
    return result.findings.map((finding) => `${finding.ok ? "ok" : "DRIFT"} ${finding.name}: ${finding.detail}`).join("\n");
}
//# sourceMappingURL=drift.js.map