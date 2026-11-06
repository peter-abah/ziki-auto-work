import type { UrlsPolicyConfig } from "./types.js";

export type DeploymentEnvironment = "dev" | "staging" | "prod";

function envSuffixes(policy: UrlsPolicyConfig | null | undefined): Record<string, string> {
  const suffixes = policy?.envSuffixes;
  if (!suffixes || typeof suffixes !== "object" || Array.isArray(suffixes)) {
    throw new Error("urls.envSuffixes must be an object of suffix -> environment (run `auto-work migrate`)");
  }
  for (const [key, value] of Object.entries(suffixes)) {
    if (typeof value !== "string" || !value) {
      throw new Error(`urls.envSuffixes.${key} must be a non-empty string (run \`auto-work migrate\`)`);
    }
  }
  return suffixes as Record<string, string>;
}

export function deploymentEnvironment(
  key: string,
  policy?: UrlsPolicyConfig | null | undefined
): DeploymentEnvironment | null {
  const suffix = key.split(":").pop() ?? "";
  const env = envSuffixes(policy)[suffix];
  return env === "dev" || env === "staging" || env === "prod" ? env : null;
}

export function workTargetKey(key: string, issueId?: string | null, ideaId?: string | null): string {
  if (issueId) return `issue:${issueId}`;
  if (ideaId) return `idea:${ideaId}`;
  return `key:${key}`;
}
