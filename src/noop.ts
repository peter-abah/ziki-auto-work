const NOOP_STATUSES = new Set([400, 409, 422]);

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const body = (error as { body?: unknown }).body;
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const message = record.message ?? record.error;
      if (typeof message === "string" && message.trim()) return message;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}

export function isNoopZikiError(error: unknown, patterns: ReadonlyArray<RegExp>): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  if (!NOOP_STATUSES.has(status)) return false;
  const message = errorMessage(error);
  return patterns.some((pattern) => pattern.test(message));
}

export const NOOP_PATTERNS = {
  reclaim: [/nothing to reclaim/i, /not stale/i],
  open: [/not awaiting confirmation/i, /requires confirmation/i, /already open/i],
  review: [/already has .*judgements?/i, /already (?:been )?(?:accepted|reviewed)/i, /not (?:awaiting|reviewable)/i],
  convert: [/valid JSON body/i]
} as const;
