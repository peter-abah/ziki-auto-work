import type { OutboxEntry, OutboxPolicyConfig, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";
import type { Logger } from "./log.js";
export interface OutboxEvent {
    type: "flushed" | "skipped-duplicate" | "failed" | "dropped" | "deferred";
    entry: OutboxEntry;
    error?: string;
}
/** Queue a write for later. Returns the stored entry. Never throws. */
export declare function queueOutbox(state: State, entry: Omit<OutboxEntry, "id" | "addedAt" | "attempts">): OutboxEntry;
export declare function outboxDepth(state: State): number;
export interface FlushOptions {
    maxPerFlush?: number;
    maxAttempts?: number;
    fifo?: boolean;
    /** Current tenant idea titles for createIdea dedupe (skip, don't re-file). */
    knownIdeaTitles?: Set<string> | string[];
    logger?: Logger;
    onEvent?: (event: OutboxEvent) => void;
    policy?: OutboxPolicyConfig | null | undefined;
}
/**
 * Flush queued writes FIFO. Stops at the first failure to preserve order;
 * entries that exhaust attempts move to `failed` (with a history-grade event)
 * instead of clogging the queue forever. Returns counts for the caller to log.
 */
export declare function flushOutbox(state: State, client: ZikiClient, options?: FlushOptions): Promise<{
    flushed: number;
    skipped: number;
    failed: number;
    pending: number;
    deferred: string | null;
}>;
