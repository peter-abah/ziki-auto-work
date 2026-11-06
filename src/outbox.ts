import { randomUUID } from "node:crypto";
import type { OutboxEntry, OutboxKind, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";
import type { Logger } from "./log.js";

const MAX_ATTEMPTS = 25;
const DEFAULT_MAX_PER_FLUSH = 5;

export interface OutboxEvent {
  type: "flushed" | "skipped-duplicate" | "failed" | "dropped" | "deferred";
  entry: OutboxEntry;
  error?: string;
}

function queue(state: State): { items: OutboxEntry[]; failed: OutboxEntry[] } {
  if (!state.outbox) state.outbox = { items: [], failed: [] };
  state.outbox.items ??= [];
  state.outbox.failed ??= [];
  return state.outbox;
}

/** Queue a write for later. Returns the stored entry. Never throws. */
export function queueOutbox(
  state: State,
  entry: Omit<OutboxEntry, "id" | "addedAt" | "attempts">
): OutboxEntry {
  const stored: OutboxEntry = {
    ...entry,
    id: `outbox-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    addedAt: new Date().toISOString(),
    attempts: 0
  };
  queue(state).items.push(stored);
  return stored;
}

export function outboxDepth(state: State): number {
  return state.outbox?.items.length ?? 0;
}

async function dispatch(
  client: ZikiClient,
  entry: OutboxEntry,
  knownIdeaTitles: Set<string>
): Promise<{ status: "flushed" | "skipped-duplicate"; detail?: string }> {
  switch (entry.kind as OutboxKind) {
    case "createIdea": {
      const title = String((entry.body as Record<string, unknown>).title ?? entry.title ?? "");
      if (title && knownIdeaTitles.has(title)) {
        return { status: "skipped-duplicate", detail: `idea already filed: ${title}` };
      }
      await client.createIdea(entry.body as Parameters<ZikiClient["createIdea"]>[0]);
      return { status: "flushed" };
    }
    case "reportPrStatus": {
      if (!entry.issueId) throw new Error("reportPrStatus entry is missing issueId");
      await client.reportPrStatus(entry.issueId, entry.body);
      return { status: "flushed" };
    }
    case "reportDeployment": {
      if (!entry.issueId) throw new Error("reportDeployment entry is missing issueId");
      await client.reportDeployment(
        entry.issueId,
        entry.body as { environment: "dev" | "staging" | "prod"; note: string }
      );
      return { status: "flushed" };
    }
    default:
      throw new Error(`unknown outbox kind: ${String((entry as OutboxEntry).kind)}`);
  }
}

export interface FlushOptions {
  maxPerFlush?: number;
  /** Current tenant idea titles for createIdea dedupe (skip, don't re-file). */
  knownIdeaTitles?: Set<string> | string[];
  logger?: Logger;
  onEvent?: (event: OutboxEvent) => void;
}

/**
 * Flush queued writes FIFO. Stops at the first failure to preserve order;
 * entries that exhaust attempts move to `failed` (with a history-grade event)
 * instead of clogging the queue forever. Returns counts for the caller to log.
 */
export async function flushOutbox(
  state: State,
  client: ZikiClient,
  options: FlushOptions = {}
): Promise<{ flushed: number; skipped: number; failed: number; pending: number; deferred: string | null }> {
  const q = queue(state);
  const max = options.maxPerFlush ?? DEFAULT_MAX_PER_FLUSH;
  const known = options.knownIdeaTitles instanceof Set ? options.knownIdeaTitles : new Set(options.knownIdeaTitles ?? []);
  let flushed = 0;
  let skipped = 0;
  let processed = 0;
  let deferred: string | null = null;
  while (q.items.length && processed < max) {
    const entry = q.items[0]!;
    try {
      const outcome = await dispatch(client, entry, known);
      q.items.shift();
      processed += 1;
      if (outcome.status === "flushed") {
        flushed += 1;
        options.onEvent?.({ type: "flushed", entry });
      } else {
        skipped += 1;
        options.onEvent?.({ type: "skipped-duplicate", entry });
      }
    } catch (error) {
      entry.attempts += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      if (entry.attempts >= MAX_ATTEMPTS) {
        q.items.shift();
        q.failed.push(entry);
        options.logger?.warn(`Outbox entry exhausted, moved to failed: ${entry.kind} ${entry.title ?? entry.id}`);
        options.onEvent?.({ type: "dropped", entry, error: entry.lastError });
      } else {
        deferred = entry.lastError;
        options.onEvent?.({ type: "deferred", entry, error: entry.lastError });
        break;
      }
    }
  }
  return { flushed, skipped, failed: q.failed.length, pending: q.items.length, deferred };
}
