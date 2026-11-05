import type { ProviderLimit } from "./types.js";

export function normalizeProviderLimit(value: unknown): ProviderLimit {
  return value === "quota" || value === "rate-limit" || value === "context" ? value : null;
}

export function providerLimitForResult(
  parsed: { ok?: boolean; blocked?: boolean; providerLimit?: unknown } | null | undefined,
  failed: boolean
): ProviderLimit {
  if (!failed) return null;
  return normalizeProviderLimit(parsed?.providerLimit);
}
