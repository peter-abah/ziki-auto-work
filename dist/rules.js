import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GENERIC_PR_TEMPLATE } from "./github.js";
import { resolvePrTemplate } from "./config.js";
export function effectiveProtectedFiles(profile) {
    const safety = profile.safety?.protectedFiles;
    if (!Array.isArray(safety) || !safety.length) {
        throw new Error("profile.safety.protectedFiles must be a non-empty array (run `auto-work migrate`)");
    }
    const configured = profile.repo.protectedFiles;
    return configured && configured.length ? configured : safety;
}
export function formatProtectedFiles(profile) {
    return effectiveProtectedFiles(profile)
        .map((file) => `- ${file}`)
        .join("\n");
}
export function workflow(profile) {
    return profile.workflow;
}
export function formatWorkflowRules(profile, options = {}) {
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
export async function loadPrTemplateText(profile, repoDir) {
    if (repoDir) {
        for (const relative of [".github/PULL_REQUEST_TEMPLATE.md", "PULL_REQUEST_TEMPLATE.md", "docs/PULL_REQUEST_TEMPLATE.md"]) {
            const file = path.join(repoDir, relative);
            if (!existsSync(file))
                continue;
            try {
                return await readFile(file, "utf8");
            }
            catch {
                // try the next location
            }
        }
    }
    const file = resolvePrTemplate(profile);
    if (existsSync(file)) {
        try {
            return await readFile(file, "utf8");
        }
        catch {
            // fall through to the generic template
        }
    }
    return GENERIC_PR_TEMPLATE;
}
export function formatPrFieldMap() {
    return [
        "Write the final Markdown PR body in `prBody`, following the repository template.",
        "Use these result fields to make it complete:",
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
//# sourceMappingURL=rules.js.map