import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EscalationRecord, EscalationType, Issue, ProfileConfig, ProfilePaths, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";
import { escalationUrl } from "./urls.js";
import { setTask } from "./state.js";
import { runCommand } from "./platform/spawn.js";
import type { Logger } from "./log.js";

const ESCALATION_TYPES = new Set<EscalationType>([
  "question",
  "work_authorization",
  "blocker",
  "scope_change",
  "human_approval"
]);

export function openEscalations(state: State): EscalationRecord[] {
  return Object.values(state.escalations).filter((escalation) => escalation.status === "open");
}

async function notify(command: string | null | undefined, title: string, body: string): Promise<void> {
  if (!command) return;
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  await runCommand(shell, args, {
    env: { AW_TITLE: title, AW_BODY: body },
    timeoutMs: 15_000
  }).catch(() => {});
}

export async function escalate(
  client: ZikiClient,
  profile: ProfileConfig,
  profilePaths: ProfilePaths,
  state: State,
  options: {
    issue?: Issue | null;
    type?: EscalationType;
    body: string;
    agentName?: string;
    logger?: Logger;
    notifyCommand?: string | null;
    maxOpen?: number;
  }
): Promise<{ ok: boolean; skipped?: boolean; escalation?: EscalationRecord; link?: string; error?: string }> {
  const open = openEscalations(state);
  if (open.length >= (options.maxOpen ?? 5)) {
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

  let response: { escalation?: { id: string } };
  try {
    response = await client.escalate(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.error(`Escalation failed: ${message}`);
    return { ok: false, error: message };
  }

  const escalation = response?.escalation;
  if (!escalation?.id) return { ok: false, error: "escalation returned no id" };

  const record: EscalationRecord = {
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
    resolvedAt: null
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
  options.logger?.warn(`Needs human (${type}) #${record.issueNumber ?? "?"}: ${body}`, {
    escalationId: record.id,
    link
  });
  await notify(options.notifyCommand, `auto-work needs you: #${record.issueNumber ?? "?"}`, `${body}\n${link}`);
  await writeNeedsHuman(state, profile, profilePaths);
  return { ok: true, escalation: record, link };
}

export async function poll(
  client: ZikiClient,
  profile: ProfileConfig,
  profilePaths: ProfilePaths,
  state: State,
  options: {
    logger?: Logger;
    markInboxRead?: boolean;
    clientForName?: (name: string | null) => ZikiClient | null;
  } = {}
): Promise<{ resolved: EscalationRecord[]; inbox?: unknown; errors: unknown[] }> {
  const resolved: EscalationRecord[] = [];
  const errors: unknown[] = [];

  for (const escalation of openEscalations(state)) {
    try {
      const owner = options.clientForName?.(escalation.agentName) ?? null;
      const response = await (owner ?? client).getEscalation(escalation.id);
      const current = response?.escalation;
      if (current?.status && current.status !== "open") {
        escalation.status = current.status;
        escalation.answer = current.resolution ?? null;
        escalation.resolvedAt = current.resolvedAt ?? new Date().toISOString();
        if (escalation.issueId) {
          setTask(
            state,
            { id: escalation.issueId, number: escalation.issueNumber, title: escalation.issueTitle },
            {
              status: "queued",
              escalationId: null,
              escalationAnswer: escalation.answer,
              escalationResolvedAt: escalation.resolvedAt
            }
          );
        }
        resolved.push(escalation);
        options.logger?.info(
          `Human answered escalation ${escalation.id} for #${escalation.issueNumber ?? "?"}: ${escalation.answer ?? "(no text)"}`
        );
      }
    } catch (error) {
      errors.push(error);
      options.logger?.warn(
        `Could not poll escalation ${escalation.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  let inbox: unknown;
  try {
    inbox = await client.inbox({ unread: true });
    const items = (inbox as { items?: Array<Record<string, unknown>> })?.items ?? [];
    const answers = items.filter((item) => item.kind === "answer");
    for (const item of answers) {
      options.logger?.info(`Inbox answer: ${String(item.payload ?? "")}`, { issueId: item.issueId });
    }
    if (options.markInboxRead !== false) {
      const ids = items.map((item) => String(item.id)).filter(Boolean);
      if (ids.length) await client.markInboxRead(ids).catch(() => {});
    }
  } catch (error) {
    errors.push(error);
    options.logger?.warn(`Could not read inbox: ${error instanceof Error ? error.message : String(error)}`);
  }

  await writeNeedsHuman(state, profile, profilePaths);
  return { resolved, inbox, errors };
}

export async function writeNeedsHuman(state: State, profile: ProfileConfig, profilePaths: ProfilePaths): Promise<void> {
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
      lines.push(
        `- **${blocker.severity}** \`${blocker.component}:${blocker.code}\` — ${blocker.message}`,
        ...(blocker.agents?.length ? [`  Agents: ${blocker.agents.join(", ")}`] : []),
        ...(typeof blocker.details?.setupUrl === "string" ? [`  Setup: ${blocker.details.setupUrl}`] : []),
        ...(typeof blocker.details?.helpUrl === "string" ? [`  Help: ${blocker.details.helpUrl}`] : []),
        `  Last attempt: ${blocker.lastAttemptAt} · attempts: ${blocker.attempts}`
      );
    }
    lines.push("");
  }
  for (const escalation of open) {
    lines.push(
      `## ${escalation.type} · #${escalation.issueNumber ?? "?"} ${escalation.issueTitle ?? ""}`.trim(),
      "",
      escalation.body,
      "",
      `- Answer in Ziki: ${escalationUrl(profile, escalation.issueNumber)}`,
      `- Escalation id: \`${escalation.id}\``,
      `- Opened: ${escalation.createdAt}`,
      ""
    );
  }
  await mkdir(path.dirname(profilePaths.needsHumanFile), { recursive: true });
  await writeFile(profilePaths.needsHumanFile, `${lines.join("\n")}\n`, "utf8");
}
