import test from "node:test";
import assert from "node:assert/strict";
import type { ProfileConfig } from "./types.js";
import { DEFAULT_LIMITS, DEFAULT_WORKFLOW } from "./config.js";
import { getProvider, listProviderIds } from "./providers/index.js";

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
      defaultBranch: "main"
    },
    agents: { workers: ["ZIKI_KEY1"], managers: [] },
    executor: { provider: "opencode", model: null },
    toolchain: {},
    checks: [],
    platformMatch: { keywords: ["desktop"] },
    prompts: { dir: "prompts/generic" },
    pr: { templateFile: "prompts/generic/pr.md" },
    discovery: { enabled: false },
    workflow: { ...DEFAULT_WORKFLOW },
    limits: { ...DEFAULT_LIMITS },
    pollSeconds: 120,
    memoryRefreshMinutes: 30,
    hitl: { enabled: true, defaultType: "question", notifyCommand: null },
    ...overrides
  };
}

const input = { prompt: "PROMPT", cwd: "/work", resultPath: "/result.json", model: "model-x" };

test("shortlist providers build commands and use stdout result mode", () => {
  const aider = getProvider("aider", profile());
  const command = aider.build(input);
  assert.equal(command.command, "aider");
  assert.ok(command.args.includes("PROMPT"));
  assert.equal(aider.resultMode, "stdout");
});

test("custom provider specs come from the profile", () => {
  const custom = profile({
    executor: { provider: "my-tool", model: null },
    providers: {
      "my-tool": { id: "my-tool", command: "my-tool", args: ["run", "{{prompt}}"], resultMode: "stdout" }
    }
  });
  const provider = getProvider("my-tool", custom);
  assert.equal(provider.resultMode, "stdout");
  assert.deepEqual(provider.build(input).args, ["run", "PROMPT"]);
});

test("provider list includes built-ins, shortlist and custom ids", () => {
  const custom = profile({ providers: { mine: { id: "mine", command: "mine", args: [] } } });
  const ids = listProviderIds(custom);
  assert.ok(ids.includes("opencode"));
  assert.ok(ids.includes("aider"));
  assert.ok(ids.includes("mine"));
});
