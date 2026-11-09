import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { escalationUrl } from "./urls.js";
import { setTask } from "./state.js";
import { runCommand } from "./platform/spawn.js";
/**
 * Human-approval convention for config-repair escalations (shared with the
 * NEEDS-HUMAN rendering and the CLI): a Ziki answer or CLI note starting
 * with APPROVE (case-insensitive) approves the proposed patch; a dismissed
 * escalation rejects it; anything else keeps the discussion open and the
 * agent must re-escalate with a revised proposal.
 */
export const APPROVAL_WORD = "APPROVE";
export function isApprovalText(text) {
    return typeof text === "string" && text.trim().toLowerCase().startsWith(APPROVAL_WORD.toLowerCase());
}
/** Interpret a human answer on a config escalation. Never throws. */
export function interpretHumanAnswer(remoteStatus, resolution) {
    if (remoteStatus === "open")
        return null;
    if (remoteStatus === "dismissed")
        return "rejected";
    if (isApprovalText(resolution))
        return "approved";
    return "needs_info";
}
const ESCALATION_TYPES = new Set([
    "question",
    "work_authorization",
    "blocker",
    "scope_change",
    "human_approval"
]);
export function openEscalations(state) {
    return Object.values(state.escalations).filter((escalation) => escalation.status === "open");
}
async function notify(command, title, body) {
    if (!command)
        return;
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    await runCommand(shell, args, {
        env: { AW_TITLE: title, AW_BODY: body },
        timeoutMs: 15_000
    }).catch(() => { });
}
export async function escalate(client, profile, profilePaths, state, options) {
    const open = openEscalations(state);
    const maxOpen = options.maxOpen ?? null;
    if (maxOpen !== null && open.length >= maxOpen) {
        options.logger?.warn(`Not escalating: ${open.length} escalations already open`);
        return { ok: false, skipped: true, error: "too_many_open" };
    }
    const type = ESCALATION_TYPES.has(options.type ?? "question") ? (options.type ?? "question") : "question";
    const body = String(options.body || "").slice(0, 2000);
    const payload = {
        body,
        type,
        ...(options.issue?.id ? { bugId: options.issue.id } : {})
    };
    let response;
    try {
        response = await client.escalate(payload);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.error(`Escalation failed: ${message}`);
        return { ok: false, error: message };
    }
    const escalation = response?.escalation;
    if (!escalation?.id)
        return { ok: false, error: "escalation returned no id" };
    const kind = options.kind ?? "issue";
    const record = {
        id: escalation.id,
        issueId: options.issue?.id ?? null,
        issueNumber: options.issue?.number ?? null,
        issueTitle: options.issue?.title ?? null,
        type,
        body,
        agentName: options.agentName ?? client.agentName ?? null,
        createdAt: new Date().toISOString(),
        status: "open",
        answer: null,
        resolvedAt: null,
        kind,
        strategy: options.strategy ?? null,
        configPatch: options.configPatch ?? null,
        decision: null,
        rounds: options.rounds ?? 1,
        remoteStatus: "open",
        appliedAt: null,
        previousId: options.previousId ?? null
    };
    state.escalations[record.id] = record;
    if (options.issue) {
        setTask(state, options.issue, {
            status: "waiting_human",
            escalationId: record.id,
            escalationAnswer: null
        });
    }
    const link = escalationUrl(profile, record.issueNumber);
    const label = record.kind === "config"
        ? `config:${record.strategy ?? record.type}`
        : `#${record.issueNumber ?? "?"}`;
    options.logger?.warn(`Needs human (${type}) ${label}: ${body}`, {
        escalationId: record.id,
        link
    });
    await notify(options.notifyCommand, `auto-work needs you: ${label}`, `${body}\n${link}`);
    await writeNeedsHuman(state, profile, profilePaths);
    // Read-back: the escalation record must not claim NEEDS-HUMAN coverage
    // that is not on disk. A missing/empty file here throws so the caller
    // handles it (retry, park) instead of assuming the human was told.
    const info = await stat(profilePaths.needsHumanFile).catch(() => null);
    if (!info || info.size === 0) {
        throw new Error(`NEEDS-HUMAN.md verification failed: ${profilePaths.needsHumanFile} missing or empty after write`);
    }
    return { ok: true, escalation: record, link };
}
export async function poll(client, profile, profilePaths, state, options = {}) {
    const resolved = [];
    const errors = [];
    for (const escalation of openEscalations(state)) {
        try {
            const owner = options.clientForName?.(escalation.agentName) ?? null;
            const response = await (owner ?? client).getEscalation(escalation.id);
            const current = response?.escalation;
            if (current?.status && current.status !== "open") {
                if ((escalation.kind ?? "issue") === "config") {
                    const decision = applyRemoteAnswer(escalation, current.status, current.resolution ?? null, options.logger);
                    if (decision === "approved" || decision === "rejected")
                        resolved.push(escalation);
                }
                else {
                    escalation.status = current.status;
                    escalation.answer = current.resolution ?? null;
                    escalation.resolvedAt = current.resolvedAt ?? new Date().toISOString();
                    if (escalation.issueId) {
                        setTask(state, { id: escalation.issueId, number: escalation.issueNumber, title: escalation.issueTitle }, {
                            status: "queued",
                            escalationId: null,
                            escalationAnswer: escalation.answer,
                            escalationResolvedAt: escalation.resolvedAt
                        });
                    }
                    options.logger?.info(`Human answered escalation ${escalation.id} for #${escalation.issueNumber ?? "?"}: ${escalation.answer ?? "(no text)"}`);
                    resolved.push(escalation);
                }
            }
        }
        catch (error) {
            errors.push(error);
            options.logger?.warn(`Could not poll escalation ${escalation.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    let inbox;
    try {
        inbox = await client.inbox({ unread: true });
        const items = inbox?.items ?? [];
        const answers = items.filter((item) => item.kind === "answer");
        for (const item of answers) {
            options.logger?.info(`Inbox answer: ${String(item.payload ?? "")}`, { issueId: item.issueId });
        }
        if (options.markInboxRead !== false) {
            const ids = items.map((item) => String(item.id)).filter(Boolean);
            if (ids.length)
                await client.markInboxRead(ids).catch(() => { });
        }
    }
    catch (error) {
        errors.push(error);
        options.logger?.warn(`Could not read inbox: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeNeedsHuman(state, profile, profilePaths);
    return { resolved, inbox, errors };
}
/**
 * Record a human answer on a loop-level config escalation WITHOUT closing
 * our workflow state, so clarifying messages stay in the loop:
 * - approved → decision set; the orchestrator applies the patch next cycle.
 * - rejected → terminal; the strategy is done for this failure episode.
 * - needs_info → the answer is stored and a revised proposal must be
 *   re-escalated (new record, rounds+1, previousId linked).
 */
export function applyRemoteAnswer(escalation, remoteStatus, resolution, logger) {
    const decision = interpretHumanAnswer(remoteStatus, resolution);
    if (!decision)
        return null;
    escalation.remoteStatus = remoteStatus;
    escalation.answer = resolution ?? null;
    escalation.resolvedAt = new Date().toISOString();
    escalation.decision = decision;
    if (decision === "rejected")
        escalation.status = "dismissed";
    logger?.info(`Config escalation ${escalation.id} decision: ${decision}`, {
        strategy: escalation.strategy ?? undefined,
        answer: escalation.answer ?? undefined
    });
    return decision;
}
/** Local-CLI approval fallback (used by `auto-work approve` when Ziki is unreachable). */
export function approveEscalation(state, escalationId, note) {
    const escalation = state.escalations[escalationId];
    if (!escalation)
        return { ok: false, error: `no escalation ${escalationId}` };
    if ((escalation.kind ?? "issue") !== "config") {
        return { ok: false, error: `escalation ${escalationId} is not a config escalation` };
    }
    if (escalation.status !== "open") {
        return { ok: false, error: `escalation ${escalationId} is ${escalation.status}` };
    }
    escalation.decision = "approved";
    escalation.answer = note ?? `${APPROVAL_WORD} via CLI`;
    escalation.resolvedAt = new Date().toISOString();
    return { ok: true };
}
/** Local-CLI rejection (used by `auto-work reject`). */
export function rejectEscalation(state, escalationId, note) {
    const escalation = state.escalations[escalationId];
    if (!escalation)
        return { ok: false, error: `no escalation ${escalationId}` };
    if ((escalation.kind ?? "issue") !== "config") {
        return { ok: false, error: `escalation ${escalationId} is not a config escalation` };
    }
    if (escalation.status !== "open") {
        return { ok: false, error: `escalation ${escalationId} is ${escalation.status}` };
    }
    escalation.decision = "rejected";
    escalation.answer = note ?? "rejected via CLI";
    escalation.status = "dismissed";
    escalation.resolvedAt = new Date().toISOString();
    return { ok: true };
}
/** Park an escalation whose proposal rounds are exhausted. */
export function markEscalationExpired(state, escalationId, reason) {
    const escalation = state.escalations[escalationId];
    if (!escalation || escalation.status !== "open")
        return false;
    escalation.status = "expired";
    escalation.answer = reason;
    escalation.resolvedAt = new Date().toISOString();
    return true;
}
/** Open config escalations for one repair strategy, oldest first. */
export function openConfigEscalations(state, strategy) {
    return openEscalations(state)
        .filter((escalation) => (escalation.kind ?? "issue") === "config" && escalation.strategy === strategy)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function writeNeedsHuman(state, profile, profilePaths) {
    const open = openEscalations(state);
    const healthBlockers = Object.values(state.health?.blockers ?? {});
    const lines = [
        "# Auto-work needs you",
        "",
        `Updated: ${new Date().toISOString()}`,
        "",
        !open.length && !healthBlockers.length ? "Nothing is waiting on you." : "",
        ""
    ];
    if (healthBlockers.length) {
        lines.push("## Blocked loop", "");
        for (const blocker of healthBlockers) {
            lines.push(`- **${blocker.severity}** \`${blocker.component}:${blocker.code}\` — ${blocker.message}`, ...(blocker.agents?.length ? [`  Agents: ${blocker.agents.join(", ")}`] : []), ...(typeof blocker.details?.setupUrl === "string" ? [`  Setup: ${blocker.details.setupUrl}`] : []), ...(typeof blocker.details?.helpUrl === "string" ? [`  Help: ${blocker.details.helpUrl}`] : []), `  Last attempt: ${blocker.lastAttemptAt} · attempts: ${blocker.attempts}`);
        }
        lines.push("");
    }
    const failedOutbox = state.outbox?.failed ?? [];
    const expiredEscalations = Object.values(state.escalations).filter((escalation) => escalation.status === "expired");
    if (failedOutbox.length || expiredEscalations.length) {
        lines.push("## Dropped work (needs a human look)", "");
        for (const entry of failedOutbox) {
            lines.push(`- outbox \`${entry.kind}\`${entry.issueNumber ? ` #${entry.issueNumber}` : ""}${entry.title ? ` (${entry.title})` : ""} — exhausted after ${entry.attempts} attempt(s): ${entry.lastError ?? "unknown error"}`);
        }
        for (const escalation of expiredEscalations) {
            lines.push(`- expired ${escalation.kind ?? "issue"} escalation \`${escalation.id}\`${escalation.strategy ? ` (${escalation.strategy})` : ""}: ${escalation.answer ?? "no reason recorded"}`);
        }
        lines.push("");
    }
    for (const escalation of open) {
        if ((escalation.kind ?? "issue") === "config") {
            lines.push(`## config repair · ${escalation.strategy ?? escalation.type}`, "", escalation.body, "", ...formatPatchLines(escalation), `  Round ${escalation.rounds ?? 1}${escalation.previousId ? ` (follows ${escalation.previousId})` : ""}`, `- Approve on Ziki: reply to escalation ${escalation.id} starting with ${APPROVAL_WORD} (anything else keeps the discussion open and triggers a revised proposal)`, `- Approve locally: \`auto-work approve ${escalation.id}${state.profile ? ` --profile ${state.profile}` : ""}\``, `- Opened: ${escalation.createdAt}`, ...(escalation.decision === "needs_info"
                ? [`- Last answer (needs a revised proposal): ${escalation.answer ?? "(empty)"}`]
                : []), "");
            continue;
        }
        lines.push(`## ${escalation.type} · #${escalation.issueNumber ?? "?"} ${escalation.issueTitle ?? ""}`.trim(), "", escalation.body, "", `- Answer in Ziki: ${escalationUrl(profile, escalation.issueNumber)}`, `- Escalation id: \`${escalation.id}\``, `- Opened: ${escalation.createdAt}`, "");
    }
    await mkdir(path.dirname(profilePaths.needsHumanFile), { recursive: true });
    await writeFile(profilePaths.needsHumanFile, `${lines.join("\n")}\n`, "utf8");
}
function formatPatchLines(escalation) {
    const ops = escalation.configPatch ?? [];
    if (!ops.length)
        return [];
    const lines = ["Proposed config patch:", ""];
    for (const op of ops) {
        lines.push(`- \`${op.path}\` → ${JSON.stringify(op.value)}${op.reason ? ` — ${op.reason}` : ""}`);
    }
    lines.push("");
    return lines;
}
//# sourceMappingURL=hitl.js.map