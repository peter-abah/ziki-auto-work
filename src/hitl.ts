import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EscalationRecord, EscalationType, Issue, JobConfig, JobPaths, State } from "./types.js";
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
  job: JobConfig,
  jobPaths: JobPaths,
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

  const link = escalationUrl(job, record.issueNumber);
  options.logger?.warn(`Needs human (${type}) #${record.issueNumber ?? "?"}: ${body}`, {
    escalationId: record.id,
    link
  });
  await notify(options.notifyCommand, `auto-work needs you: #${record.issueNumber ?? "?"}`, `${body}\n${link}`);
  await writeNeedsHuman(state, job, jobPaths);
  return { ok: true, escalation: record, link };
}

export async function poll(
  client: ZikiClient,
  job: JobConfig,
  jobPaths: JobPaths,
  state: State,
  options: {
    logger?: Logger;
    markInboxRead?: boolean;
    clientForName?: (name: string | null) => ZikiClient | null;
  } = {}
): Promise<{ resolved: EscalationRecord[]; inbox?: unknown }> {
  const resolved: EscalationRecord[] = [];

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
    options.logger?.warn(`Could not read inbox: ${error instanceof Error ? error.message : String(error)}`);
  }

  await writeNeedsHuman(state, job, jobPaths);
  return { resolved, inbox };
}

export async function writeNeedsHuman(state: State, job: JobConfig, jobPaths: JobPaths): Promise<void> {
  const open = openEscalations(state);
  const lines = [
    "# Auto-work needs you",
    "",
    `Updated: ${new Date().toISOString()}`,
    "",
    open.length ? "" : "Nothing is waiting on you.",
    ""
  ];
  for (const escalation of open) {
    lines.push(
      `## ${escalation.type} · #${escalation.issueNumber ?? "?"} ${escalation.issueTitle ?? ""}`.trim(),
      "",
      escalation.body,
      "",
      `- Answer in Ziki: ${escalationUrl(job, escalation.issueNumber)}`,
      `- Escalation id: \`${escalation.id}\``,
      `- Opened: ${escalation.createdAt}`,
      ""
    );
  }
  await mkdir(path.dirname(jobPaths.needsHumanFile), { recursive: true });
  await writeFile(jobPaths.needsHumanFile, `${lines.join("\n")}\n`, "utf8");
}
