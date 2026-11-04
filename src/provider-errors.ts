import type { ProviderLimit } from "./types.js";

const CONTEXT_PATTERNS = [
  /maximum context length/i,
  /context (window|length)/i,
  /context_length_exceeded/i,
  /too many tokens.*context/i
];

const QUOTA_PATTERNS = [
  /insufficient[_ ]quota/i,
  /exceeded your current quota/i,
  /quota (exceeded|exhausted)/i,
  /credit balance/i,
  /out of credits?/i,
  /no credits?/i,
  /usage limit/i,
  /billing/i,
  /token limit reached/i,
  /resource[_ ]exhausted/i
];

const RATE_PATTERNS = [/\b429\b/i, /rate limit/i, /too many requests/i, /overloaded/i, /capacity/i];

export function classifyProviderLimit(text: string | undefined | null): ProviderLimit {
  if (!text) return null;
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(text))) return "context";
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return "quota";
  if (RATE_PATTERNS.some((pattern) => pattern.test(text))) return "rate-limit";
  return null;
}
