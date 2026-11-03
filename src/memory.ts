import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobPaths, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";

export interface MemoryContext {
  loadedAt: string;
  agent: { name: string; level: string; instructions: string | null } | null;
  projectNotes: { body?: string; version?: number } | null;
  notesComments: Array<{ body: string; authorName?: string; by?: string; createdAt?: string }>;
  ownNotes: Array<{ id: string; body: string; createdAt: string }>;
  mistakes: Array<Record<string, unknown>>;
  fromCache?: boolean;
}

function cacheFile(jobPaths: JobPaths): string {
  return jobPaths.memoryFile;
}

export async function readCachedMemory(jobPaths: JobPaths): Promise<MemoryContext | null> {
  if (!existsSync(cacheFile(jobPaths))) return null;
  try {
    return JSON.parse(await readFile(cacheFile(jobPaths), "utf8")) as MemoryContext;
  } catch {
    return null;
  }
}

export async function writeCachedMemory(jobPaths: JobPaths, memory: MemoryContext): Promise<void> {
  await mkdir(jobPaths.stateDir, { recursive: true });
  await writeFile(cacheFile(jobPaths), `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

export async function loadMemoryContext(
  client: ZikiClient,
  jobPaths: JobPaths,
  options: { maxAgeMinutes?: number; force?: boolean } = {}
): Promise<MemoryContext> {
  const cached = await readCachedMemory(jobPaths);
  if (!options.force && cached?.loadedAt) {
    const ageMinutes = (Date.now() - new Date(cached.loadedAt).getTime()) / 60000;
    if (ageMinutes < (options.maxAgeMinutes ?? 30)) return { ...cached, fromCache: true };
  }

  const [me, notes, comments, ownNotes, mistakes] = await Promise.all([
    client.me().catch(() => null),
    client.projectNotes().catch(() => null),
    client.projectNotesComments().catch(() => null),
    client.agentNotes().catch(() => null),
    client.mistakes().catch(() => null)
  ]);

  const mistakeList = Array.isArray(mistakes)
    ? mistakes
    : (mistakes?.mistakes ?? (mistakes as { items?: unknown[] } | null)?.items ?? []);

  const memory: MemoryContext = {
    loadedAt: new Date().toISOString(),
    agent: me ? { name: me.name, level: me.level, instructions: me.instructions ?? null } : null,
    projectNotes: notes?.notes ?? null,
    notesComments: (comments?.items ?? []).slice(0, 30),
    ownNotes: (ownNotes?.items ?? []).slice(0, 50),
    mistakes: (mistakeList as Array<Record<string, unknown>>).slice(0, 50)
  };
  await writeCachedMemory(jobPaths, memory);
  return { ...memory, fromCache: false };
}

function clip(text: unknown, max: number): string {
  const value = text === undefined || text === null ? "" : String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function formatMemoryForPrompt(memory: MemoryContext | null, maxChars = 14_000): string {
  if (!memory) return "(no memory loaded)";
  const parts: string[] = [];
  if (memory.agent?.instructions) {
    parts.push(`## Owner's standing instructions\n${clip(memory.agent.instructions, 3000)}`);
  }
  if (memory.projectNotes?.body) {
    parts.push(`## Shared project notes (v${memory.projectNotes.version ?? "?"})\n${clip(memory.projectNotes.body, 5000)}`);
  }
  if (memory.notesComments.length) {
    parts.push(
      `## Recent notes discussion\n${memory.notesComments
        .slice(0, 12)
        .map((comment) => `- ${comment.authorName || comment.by || "someone"}: ${clip(comment.body, 500)}`)
        .join("\n")}`
    );
  }
  if (memory.ownNotes.length) {
    parts.push(
      `## Your own notes (private memory)\n${memory.ownNotes
        .slice(0, 20)
        .map((note) => `- [${note.createdAt?.slice(0, 10) ?? "?"}] ${clip(note.body, 700)}`)
        .join("\n")}`
    );
  }
  if (memory.mistakes.length) {
    parts.push(
      `## Known mistakes to avoid\n${memory.mistakes
        .slice(0, 15)
        .map(
          (mistake) =>
            `- ${clip(mistake.category ?? "general", 60)}: ${clip(mistake.title ?? mistake.antiPattern ?? "", 200)} → ${clip(mistake.remediation ?? "", 300)}`
        )
        .join("\n")}`
    );
  }
  const text = parts.join("\n\n") || "(no memory yet)";
  return clip(text, maxChars);
}

export function learningKey(issue: { id?: string | null; number?: number | string | null } | null, outcome: string): string {
  return `note:${issue?.id ?? issue?.number ?? "unknown"}:${outcome}`;
}

export async function recordLearning(
  client: ZikiClient,
  options: {
    issue: { id?: string | null; number?: number | string | null; title?: string | null } | null;
    outcome: string;
    summary?: string;
    details?: string;
    shared?: boolean;
    state?: State | null;
    agentName?: string;
  }
): Promise<{ skipped?: boolean; key: string; privateNote?: unknown; sharedComment?: unknown }> {
  const key = learningKey(options.issue, options.outcome);
  if (options.state?.noteDedupe?.[key] && Date.now() - options.state.noteDedupe[key]! < 24 * 60 * 60 * 1000) {
    return { skipped: true, key };
  }

  const heading = `## ${new Date().toISOString().slice(0, 10)} · #${options.issue?.number ?? "?"} ${options.issue?.title ?? ""}`.trim();
  const body = [
    heading,
    `Outcome: ${options.outcome}`,
    options.summary ? `Summary: ${options.summary}` : null,
    options.details ? `\n${options.details}` : null,
    `\nAgent: ${options.agentName ?? "agent"}`
  ]
    .filter(Boolean)
    .join("\n");

  const result: { key: string; privateNote?: unknown; sharedComment?: unknown } = { key };
  try {
    result.privateNote = await client.addAgentNote(body);
  } catch {
    // notes are best-effort
  }
  if (options.shared) {
    try {
      result.sharedComment = await client.addProjectNoteComment({
        body: `**Learning from #${options.issue?.number ?? "?"} (${options.outcome})** — ${options.summary ?? ""}\n\n${clip(options.details, 1500)}`
      });
    } catch {
      // best-effort
    }
  }
  if (options.state) {
    options.state.noteDedupe[key] = Date.now();
  }
  return result;
}

export async function recordTaskNote(
  client: ZikiClient,
  task: { id?: string | null; number?: number | string | null; title?: string | null },
  outcome: string,
  summary: string | undefined,
  details: string | undefined,
  state: State | null,
  agentName: string
) {
  return recordLearning(client, {
    issue: task,
    outcome,
    summary,
    details,
    shared: outcome === "delivered" || outcome === "merged",
    state,
    agentName
  });
}
