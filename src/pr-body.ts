import type { AgentResult, Issue, ProfileConfig } from "./types.js";
import { buildPrBody } from "./github.js";
import type { PrBodyInput } from "./github.js";
import { scanSecretsText } from "./checks.js";
import { issueUrl } from "./urls.js";

function unwrapFence(value: string): string {
  const text = value.trim();
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1]!.trim() : text;
}

function maxBodyChars(profile: ProfileConfig): number {
  const value = (profile.pr as unknown as Record<string, unknown> | undefined)?.maxBodyChars;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("profile.pr.maxBodyChars must be a positive integer (run `auto-work migrate`)");
  }
  return value;
}

function fallbackReason(value: string, profile: ProfileConfig): string | null {
  if (!value) return "empty";
  if (value.length > maxBodyChars(profile)) return `too long (${value.length} chars)`;
  if (/\{\{[a-zA-Z0-9_]+\}\}/.test(value)) return "unresolved placeholders";
  if (scanSecretsText(value, profile.safety?.secretPatterns).length) return "possible secret";
  return null;
}

export async function preparePrBody(input: {
  profile: ProfileConfig;
  issue: Issue;
  result: AgentResult;
  fallback: PrBodyInput;
}): Promise<{ body: string; source: "agent" | "fallback"; reason?: string }> {
  const agentBody = unwrapFence(typeof input.result.prBody === "string" ? input.result.prBody : "");
  const reason = fallbackReason(agentBody, input.profile);
  if (!reason) {
    const ticket = issueUrl(input.profile, input.issue);
    const body =
      agentBody.includes(ticket) || agentBody.includes(`#${input.issue.number}`)
        ? agentBody
        : `Ziki: ${ticket}\n\n${agentBody}`;
    return { body, source: "agent" };
  }
  return {
    body: await buildPrBody(input.profile, input.fallback),
    source: "fallback",
    reason
  };
}
