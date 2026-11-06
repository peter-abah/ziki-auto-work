import test from "node:test";
import assert from "node:assert/strict";
import type { ProfileConfig } from "./types.js";
import { DEFAULT_WORKFLOW, DEFAULT_LIMITS } from "./config.js";
import { branchName } from "./github.js";
import { normalizeCommitMessage } from "./orchestrator.js";
import { effectiveProtectedFiles, formatWorkflowRules } from "./rules.js";
import { loadInitTemplates } from "./config-templates.js";

const templates = await loadInitTemplates();
const safetyProtected = (templates.safety as { protectedFiles: string[] }).protectedFiles;

function profile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    ziki: { baseUrl: "https://ziki.dev", projectId: "project_demo", projectSlug: "demo", platform: "desktop" },
    stack: "Flutter",
    repo: {
      url: "git@github.com:fork/demo.git",
      upstream: "https://github.com/owner/demo.git",
      base: "staging",
      githubRepo: "owner/demo",
      forkOwner: "fork",
      defaultBranch: "main",
      teamLead: "@lead",
      protectedFiles: ["AGENTS.md"]
    },
    agents: { workers: ["ZIKI_KEY1"], managers: [] },
    executor: { provider: "opencode", model: null },
    toolchain: {},
    checks: [],
    platformMatch: { keywords: ["desktop"] },
    prompts: { dir: "prompts/generic" },
    pr: { templateFile: "prompts/generic/pr.md", teamLead: "@lead" },
    safety: JSON.parse(JSON.stringify(templates.safety)),
    discovery: { enabled: false },
    workflow: { ...DEFAULT_WORKFLOW },
    limits: { ...DEFAULT_LIMITS },
    pollSeconds: 120,
    memoryRefreshMinutes: 30,
    hitl: { enabled: true, defaultType: "question", notifyCommand: null },
    ...overrides
  };
}

test("formatWorkflowRules surfaces limits, target, team lead and protected files", () => {
  const text = formatWorkflowRules(profile(), { branch: "fix/12-demo" });
  assert.match(text, /Maximum files per change: \*\*5\*\*/);
  assert.match(text, /Maximum changed lines: \*\*400\*\*/);
  assert.match(text, /`owner\/demo` → `staging`/);
  assert.match(text, /`fork:fix\/12-demo`/);
  assert.match(text, /@lead/);
  assert.match(text, /AGENTS\.md/);
});

test("effectiveProtectedFiles uses repo config or the safety policy", () => {
  assert.deepEqual(effectiveProtectedFiles(profile()), ["AGENTS.md"]);
  assert.deepEqual(effectiveProtectedFiles(profile({ repo: { ...profile().repo, protectedFiles: [] } })), safetyProtected);
  assert.throws(() => effectiveProtectedFiles({} as ProfileConfig), /safety\.protectedFiles/);
});

test("branchName honors a configured prefix", () => {
  assert.equal(branchName({ number: 12 }, "Fix the widget", "fix"), "fix/12-fix-the-widget");
  assert.equal(branchName({ number: 12 }, "Fix the widget", "chore"), "chore/12-fix-the-widget");
});

test("normalizeCommitMessage accepts configured types and falls back otherwise", () => {
  const issue = { number: 12, title: "Fix it" } as any;
  assert.equal(normalizeCommitMessage("fix(12): correct thing", issue, ["fix"]), "fix(12): correct thing");
  assert.equal(normalizeCommitMessage("docs(12): explain thing", issue, ["fix"]), "fix(12): Fix it");
  assert.equal(normalizeCommitMessage(undefined, issue, ["fix"]), "fix(12): Fix it");
});
