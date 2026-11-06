import type { NoopPolicyConfig } from "./types.js";

export interface NoopPolicy {
  statuses?: number[];
  patterns?: Record<string, string[]>;
}

function resolveStatuses(policy: NoopPolicy | NoopPolicyConfig | null | undefined): Set<number> {
  const statuses = policy?.statuses;
  if (!Array.isArray(statuses) || !statuses.every((entry) => typeof entry === "number")) {
    throw new Error("noop.statuses must be an array of numbers (run `auto-work migrate`)");
  }
  return new Set(statuses);
}

export function resolvePatterns(
  policy: NoopPolicy | NoopPolicyConfig | null | undefined
): Record<string, RegExp[]> {
  const patterns = policy?.patterns;
  if (!patterns || typeof patterns !== "object" || Array.isArray(patterns)) {
    throw new Error("noop.patterns must be an object of action -> regex strings (run `auto-work migrate`)");
  }
  const out: Record<string, RegExp[]> = {};
  for (const [action, list] of Object.entries(patterns)) {
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
      throw new Error(`noop.patterns.${action} must be an array of regex strings (run \`auto-work migrate\`)`);
    }
    out[action] = list.map((source) => new RegExp(source, "i"));
  }
  return out;
}

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

export function isNoopZikiError(
  error: unknown,
  patterns: ReadonlyArray<RegExp>,
  policy: NoopPolicy | NoopPolicyConfig | null | undefined
): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  if (!resolveStatuses(policy).has(status)) return false;
  const message = errorMessage(error);
  return patterns.some((pattern) => pattern.test(message));
}

/** Resolve one action's compiled patterns (e.g. "reclaim") from policy. */
export function noopPatterns(
  policy: NoopPolicy | NoopPolicyConfig | null | undefined,
  action: string
): RegExp[] {
  return resolvePatterns(policy)[action] ?? [];
}
