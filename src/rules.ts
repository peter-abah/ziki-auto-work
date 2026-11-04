import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ProfileConfig, WorkflowConfig } from "./types.js";
import { DEFAULT_PROTECTED } from "./checks.js";
import { GENERIC_PR_TEMPLATE } from "./github.js";
import { resolvePrTemplate } from "./config.js";

export function effectiveProtectedFiles(profile: ProfileConfig): string[] {
  const configured = profile.repo.protectedFiles;
  return configured && configured.length ? configured : DEFAULT_PROTECTED;
}

export function formatProtectedFiles(profile: ProfileConfig): string {
  return effectiveProtectedFiles(profile)
    .map((file) => `- ${file}`)
    .join("\n");
}

export function workflow(profile: ProfileConfig): WorkflowConfig {
  return profile.workflow;
}

export function formatWorkflowRules(
  profile: ProfileConfig,
  options: { branch?: string } = {}
): string {
  const w = profile.workflow;
  const branch = options.branch ?? `${w.branchPrefix}/<issue>-<slug>`;
  const teamLead = profile.pr.teamLead || profile.repo.teamLead || "(not set)";
  return [
    `- Maximum files per change: **${w.maxFiles}**`,
    `- Maximum changed lines: **${w.maxLines}** (insertions + deletions)`,
    `- Branch: \`${branch}\` (the orchestrator creates it)`,
    `- Commit types: ${w.commitTypes.join(", ")}`,
    `- Tests required for changed behaviour: ${w.requireTests ? "yes" : "no"}`,
    `- PR target: \`${profile.repo.githubRepo}\` → \`${profile.repo.base}\``,
    `- PR head: \`${profile.repo.forkOwner}:${options.branch ?? `<branch>`}\``,
    `- Team lead: ${teamLead}`,
    `- Do not commit, push, open the PR, or call Ziki; the orchestrator does that.`,
    "",
    "Protected files (never change without an explicit reviewer agreement):",
    formatProtectedFiles(profile)
  ].join("\n");
}

export async function loadPrTemplateText(profile: ProfileConfig): Promise<string> {
  const file = resolvePrTemplate(profile);
  if (existsSync(file)) {
    try {
      return await readFile(file, "utf8");
    } catch {
      // fall through to the generic template
    }
  }
  return GENERIC_PR_TEMPLATE;
}

export function formatPrFieldMap(): string {
  return [
    "The orchestrator fills the PR template from your JSON result:",
    "- `description` → What changed",
    "- `testResults` / `testedAgainst` → Test evidence",
    "- `howToTest` → How to test",
    "- `whatToExpect` → What to expect",
    "- `screenshots` → Screenshots / recording",
    "- `risks` / `notes` → Risks / follow-ups and Notes",
    "- `checks` → configured check results",
    "",
    "Make those fields complete enough for the template; do not open the PR yourself."
  ].join("\n");
}
