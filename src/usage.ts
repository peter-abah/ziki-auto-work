import type { ProviderUsageConfig, TokenUsage } from "./types.js";

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, total: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage {
  if (!b) return { ...a };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    ...(a.cached !== undefined || b.cached !== undefined ? { cached: (a.cached ?? 0) + (b.cached ?? 0) } : {}),
    ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
    ...(a.estimated || b.estimated ? { estimated: true } : {})
  };
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function usageFromObject(value: Record<string, unknown>, allowGeneric = false): TokenUsage | null {
  const input =
    numberFrom(value.input_tokens) ??
    numberFrom(value.inputTokens) ??
    numberFrom(value.prompt_tokens) ??
    numberFrom(value.promptTokens) ??
    numberFrom(value.promptTokenCount) ??
    (allowGeneric ? numberFrom(value.input) : undefined);
  const output =
    numberFrom(value.output_tokens) ??
    numberFrom(value.outputTokens) ??
    numberFrom(value.completion_tokens) ??
    numberFrom(value.completionTokens) ??
    numberFrom(value.candidatesTokenCount) ??
    (allowGeneric ? numberFrom(value.output) : undefined);
  const total =
    numberFrom(value.total_tokens) ??
    numberFrom(value.totalTokens) ??
    numberFrom(value.totalTokenCount) ??
    (allowGeneric ? numberFrom(value.total) : undefined);
  const cached =
    numberFrom(value.cached_input_tokens) ??
    numberFrom(value.cachedInputTokens) ??
    numberFrom(value.cache_read_input_tokens) ??
    numberFrom(value.cachedContentTokenCount) ??
    (allowGeneric ? numberFrom(value.cached) : undefined);
  const cost =
    numberFrom(value.total_cost_usd) ??
    numberFrom(value.cost_usd) ??
    numberFrom(value.costUsd) ??
    (allowGeneric ? numberFrom(value.cost) : undefined);
  if (input === undefined && output === undefined && total === undefined && cost === undefined) return null;
  const resolvedInput = input ?? 0;
  const resolvedOutput = output ?? 0;
  const resolvedTotal = total ?? resolvedInput + resolvedOutput;
  return {
    input: resolvedInput,
    output: resolvedOutput,
    total: resolvedTotal,
    ...(cached !== undefined ? { cached } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {})
  };
}

function findUsage(value: unknown, found: TokenUsage[], parentKey = ""): void {
  if (Array.isArray(value)) {
    for (const item of value) findUsage(item, found, parentKey);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const allowGeneric =
    parentKey === "tokens" ||
    parentKey === "usage" ||
    record.type === "usage" ||
    ("tokens" in record && (record.cost !== undefined || record.costUsd !== undefined));
  const usage = usageFromObject(record, allowGeneric);
  if (usage) found.push(usage);
  for (const [key, child] of Object.entries(record)) findUsage(child, found, key);
}

function fromRegex(text: string, config: ProviderUsageConfig["regex"]): TokenUsage | null {
  if (!config) return null;
  const capture = (pattern: string | undefined): number | undefined => {
    if (!pattern) return undefined;
    try {
      return numberFrom(text.match(new RegExp(pattern, "im"))?.[1]);
    } catch {
      return undefined;
    }
  };
  const input = capture(config.input);
  const output = capture(config.output);
  const total = capture(config.total);
  const cost = capture(config.cost);
  if (input === undefined && output === undefined && total === undefined && cost === undefined) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    total: total ?? (input ?? 0) + (output ?? 0),
    ...(cost !== undefined ? { costUsd: cost } : {})
  };
}

export function parseUsage(text: string | undefined, config?: ProviderUsageConfig): TokenUsage | null {
  if (!text) return null;
  const regex = fromRegex(text, config?.regex);
  if (regex) return regex;

  const found: TokenUsage[] = [];
  const whole = text.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    try {
      findUsage(JSON.parse(whole), found);
    } catch {
      // fall through to JSONL
    }
  }
  if (!found.length) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
      try {
        findUsage(JSON.parse(trimmed), found);
      } catch {
        // ignore non-JSON log lines
      }
    }
  }
  if (found.length) {
    const withTotal = found.filter((entry) => entry.total > 0);
    const selected = (withTotal.at(-1) ?? found.at(-1))!;
    if (selected.costUsd === undefined) {
      const cost = found.find((entry) => entry.costUsd !== undefined)?.costUsd;
      if (cost !== undefined) selected.costUsd = cost;
    }
    return selected;
  }

  if (config?.estimate) {
    const total = Math.max(1, Math.ceil(text.length / 4));
    return { input: 0, output: total, total, estimated: true };
  }
  return null;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function usagePercent(used: number, limit: number | null | undefined): number | null {
  if (limit === null || limit === undefined || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}
