import type { IdeaPolicyConfig } from "./types.js";

export interface IdeaSanitizePolicy {
  summaryMin?: number;
  suffix?: string;
  summaryMax?: number;
  titleMax?: number;
  descriptionMax?: number;
  fallback?: string;
}

function requirePolicy(policy: IdeaSanitizePolicy | IdeaPolicyConfig | null | undefined): {
  summaryMin: number;
  suffix: string;
  summaryMax: number;
  titleMax: number;
  descriptionMax: number;
  fallback: string;
} {
  if (!policy || typeof policy !== "object") {
    throw new Error("idea policy is required (run `auto-work migrate`)");
  }
  const { summaryMin, suffix, summaryMax, titleMax, descriptionMax, fallback } = policy;
  if (typeof summaryMin !== "number" || !Number.isFinite(summaryMin) || summaryMin < 0) {
    throw new Error("idea.summaryMin must be a non-negative number (run `auto-work migrate`)");
  }
  if (typeof suffix !== "string") {
    throw new Error("idea.suffix must be a string (run `auto-work migrate`)");
  }
  for (const [key, value] of [["summaryMax", summaryMax], ["titleMax", titleMax], ["descriptionMax", descriptionMax]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || (value as number) <= 0) {
      throw new Error(`idea.${key} must be a positive number (run \`auto-work migrate\`)`);
    }
  }
  return {
    summaryMin,
    suffix,
    summaryMax: summaryMax as number,
    titleMax: titleMax as number,
    descriptionMax: descriptionMax as number,
    fallback: typeof fallback === "string" ? fallback : ""
  };
}

export function ideaPolicyLimits(policy: IdeaSanitizePolicy | IdeaPolicyConfig | null | undefined): {
  titleMax: number;
  descriptionMax: number;
} {
  const resolved = requirePolicy(policy);
  return { titleMax: resolved.titleMax, descriptionMax: resolved.descriptionMax };
}

export function sanitizeIdeaSummary(
  value: unknown,
  fallback = "",
  policy?: IdeaSanitizePolicy | IdeaPolicyConfig | null | undefined
): string {
  const resolved = requirePolicy(policy);
  const raw = String(value || fallback || "").trim();
  let text = raw
    .replace(/\]\(/g, " ")
    .replace(/[#*`>|]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) text = "Desktop parity gap found by discovery.";
  if (text.length < resolved.summaryMin) text = `${text}${resolved.suffix}`.trim();
  return text.slice(0, resolved.summaryMax);
}
