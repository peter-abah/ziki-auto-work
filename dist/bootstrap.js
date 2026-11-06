import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZikiClient } from "./ziki.js";
import { inspectKeys } from "./keys.js";
import { loadEnv } from "./config.js";
import { paths, safeName } from "./platform/paths.js";
import { runCommand } from "./platform/spawn.js";
const QUALIFYING_LEVELS = new Set(["working", "manager", "merger"]);
async function bootstrapTemplate() {
    const { loadInitTemplates } = await import("./config-templates.js");
    const templates = await loadInitTemplates();
    const record = templates;
    const bootstrap = (templates.bootstrap ?? {});
    const baseUrl = record.defaultBaseUrl;
    if (typeof baseUrl !== "string" || !baseUrl)
        throw new Error("init templates missing defaultBaseUrl");
    const num = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    return {
        baseUrl,
        transport: (templates.transport ?? {}),
        operations: (templates.operations ?? {}),
        endpoints: (templates.endpoints ?? {}),
        agentName: typeof bootstrap.agentName === "string" && bootstrap.agentName ? bootstrap.agentName : "bootstrap",
        reasonSlice: num(bootstrap.reasonSlice, 500),
        notifySlice: num(bootstrap.notifySlice, 500),
        escalationSlice: num(bootstrap.escalationSlice, 1900)
    };
}
export function bootstrapDir(profileName) {
    return path.join(paths().profilesDir, safeName(profileName || "unknown"));
}
export function bootstrapFile(profileName) {
    return path.join(bootstrapDir(profileName), "BOOTSTRAP.json");
}
export function bootstrapNeedsFile(profileName) {
    return path.join(bootstrapDir(profileName), "NEEDS-HUMAN.md");
}
async function readBootstrapState(profileName) {
    try {
        const raw = await readFile(bootstrapFile(profileName), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object")
            return null;
        return {
            version: 1,
            at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
            profile: typeof parsed.profile === "string" ? parsed.profile : null,
            reason: typeof parsed.reason === "string" ? parsed.reason : "",
            keyEnvName: typeof parsed.keyEnvName === "string" ? parsed.keyEnvName : null,
            escalationId: typeof parsed.escalationId === "string" ? parsed.escalationId : null,
            escalationAnswer: typeof parsed.escalationAnswer === "string" ? parsed.escalationAnswer : null,
            escalationResolvedAt: typeof parsed.escalationResolvedAt === "string" ? parsed.escalationResolvedAt : null
        };
    }
    catch {
        return null;
    }
}
/** First working-or-better key; no filesystem search, only the validated env file. */
function pickWorkingKey(inspections) {
    const usable = inspections.filter((item) => item.ok && item.key);
    return (usable.find((item) => item.level && QUALIFYING_LEVELS.has(item.level)) ??
        usable[0] ??
        null);
}
export function buildEscalationBody(reason, profileName, options = {}) {
    return [
        "[config bootstrap] auto-work could not start: the local config is missing or invalid.",
        "",
        `Reason: ${reason}`.slice(0, options.reasonSlice ?? 500),
        `Profile: ${profileName ?? "(unknown)"}`,
        "",
        "The loop did not start, so no agent ran and nothing was changed. " +
            "Reply with guidance (e.g. the correct project, platform, or repo to use) " +
            "and it will be picked up on the next start. " +
            "Or fix the config locally (`auto-work init`, `auto-work keys import <file>`, `auto-work config --validate`) and start again."
    ].join("\n");
}
export function buildNeedsHumanBody(options) {
    const lines = [
        "# auto-work needs you (startup blocked)",
        "",
        `Updated: ${new Date().toISOString()}`,
        "",
        "The loop could not start: the local config is missing or invalid.",
        "",
        `Reason: ${options.reason}`,
        ""
    ];
    if (options.keyEnvName) {
        lines.push(`A working Ziki key was found in the env file (${options.keyEnvName}) and an escalation was filed on Ziki.`);
        lines.push("");
    }
    else {
        lines.push("No usable Ziki key was found in the env file, so nothing could be asked on Ziki.");
        lines.push("");
    }
    if (options.escalationId) {
        lines.push(`- Ziki escalation: ${options.escalationId} (answer there or fix locally)`);
        if (options.escalationAnswer)
            lines.push(`- Latest answer: ${options.escalationAnswer}`);
        lines.push("");
    }
    lines.push("Next steps (pick one):");
    lines.push("- `auto-work init` (interactive setup) or `auto-work init --discover` (key-first auto setup)");
    lines.push("- `auto-work keys import <file>` then `auto-work config --validate`");
    lines.push("- `auto-work doctor` to see exactly what is missing");
    lines.push("- Then `auto-work start` (or bare `auto-work`) to run");
    return `${lines.join("\n")}\n`;
}
async function notifyDesktop(title, body, notifySlice = 500) {
    if (process.platform !== "linux")
        return;
    await runCommand("notify-send", ["auto-work", `${title}\n${body}`.slice(0, notifySlice)], {
        timeoutMs: 10_000
    }).catch(() => { });
}
/**
 * Startup fallback when the config is missing or invalid and the loop cannot
 * even boot. Degrades gracefully, step by step:
 * 1. Try a previously filed escalation first (adopt any human answer).
 * 2. Else try ONE validated env-file key to file a fresh escalation on Ziki.
 * 3. Always: write NEEDS-HUMAN.md, desktop notification, and console guidance.
 * Never writes keys anywhere, never probes beyond one read-only validation
 * per key, never invents configuration.
 */
export async function bootstrapOnConfigFailure(options) {
    const { profileName = null } = options;
    const reason = options.reason instanceof Error ? options.reason.message : String(options.reason ?? "unknown error");
    const logger = options.logger;
    const dir = bootstrapDir(profileName);
    await mkdir(dir, { recursive: true }).catch(() => { });
    const needsFile = bootstrapNeedsFile(profileName);
    const previous = await readBootstrapState(profileName);
    const tpl = await bootstrapTemplate();
    let keyEnvName = null;
    let inspection = null;
    try {
        const env = await loadEnv().catch(() => ({}));
        const inspections = await inspectKeys(env, tpl.baseUrl).catch(() => []);
        inspection = pickWorkingKey(inspections);
        keyEnvName = inspection?.envName ?? null;
    }
    catch (error) {
        logger?.warn(`Bootstrap key check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let escalationId = previous?.escalationId ?? null;
    let escalationAnswer = previous?.escalationAnswer ?? null;
    let escalated = false;
    const clientFor = (key) => new ZikiClient({
        baseUrl: tpl.baseUrl,
        apiKey: key.key,
        projectId: "",
        projectSlug: "",
        endpoints: tpl.endpoints,
        transport: tpl.transport,
        operations: tpl.operations,
        agentName: key.agent ?? tpl.agentName
    });
    // Reap a previously filed escalation first — a human may already have answered.
    if (escalationId && inspection) {
        try {
            const current = await clientFor(inspection).getEscalation(escalationId);
            const status = current?.escalation?.status;
            if (status && status !== "open") {
                escalationAnswer = current?.escalation?.resolution != null
                    ? String((current?.escalation).resolution)
                    : "(resolved without text)";
                logger?.info(`Bootstrap escalation ${escalationId} resolved: ${escalationAnswer}`);
                escalationId = null;
            }
        }
        catch (error) {
            logger?.warn(`Could not re-check bootstrap escalation: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // File a fresh escalation when possible and none is open.
    if (!escalationId && inspection) {
        try {
            const response = await clientFor(inspection).escalate({
                body: buildEscalationBody(reason, profileName, { reasonSlice: tpl.reasonSlice }).slice(0, tpl.escalationSlice),
                type: "blocker"
            });
            if (response?.escalation?.id) {
                escalationId = response.escalation.id;
                escalated = true;
                logger?.warn(`Bootstrap escalation filed: ${escalationId}`);
            }
        }
        catch (error) {
            logger?.warn(`Bootstrap escalation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const state = {
        version: 1,
        at: new Date().toISOString(),
        profile: profileName,
        reason: reason.slice(0, tpl.reasonSlice),
        keyEnvName,
        escalationId,
        escalationAnswer,
        escalationResolvedAt: escalationAnswer ? new Date().toISOString() : previous?.escalationResolvedAt ?? null
    };
    await writeFile(bootstrapFile(profileName), `${JSON.stringify(state, null, 2)}\n`, "utf8").catch(() => { });
    const body = buildNeedsHumanBody({
        reason,
        profileName,
        keyEnvName,
        escalationId,
        escalationAnswer
    });
    await writeFile(needsFile, body, "utf8").catch(() => { });
    await notifyDesktop("auto-work cannot start", escalationId ? `Escalation ${escalationId} filed on Ziki. See NEEDS-HUMAN.md.` : reason.slice(0, tpl.notifySlice), tpl.notifySlice);
    return { escalated, escalationId, keyEnvName, needsHumanFile: needsFile };
}
//# sourceMappingURL=bootstrap.js.map