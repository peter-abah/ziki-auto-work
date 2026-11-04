import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProfileConfig } from "./types.js";
import { DEFAULT_LIMITS, DEFAULT_WORKFLOW } from "./config.js";
import { buildAgentEnv, buildCheckEnv, envFilesFor, toolchainPath } from "./env.js";

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
    executor: { provider: "opencode", model: null, env: { DEMO_TOKEN: "token" } },
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

test("env precedence: executor env then provider then extra", () => {
  const env = buildAgentEnv(profile(), { PROVIDER: "p", SHARED: "provider" }, { EXTRA: "e", SHARED: "extra" });
  assert.equal(env.DEMO_TOKEN, "token");
  assert.equal(env.PROVIDER, "p");
  assert.equal(env.EXTRA, "e");
  assert.equal(env.SHARED, "extra");
});

test("check env merges executor env and per-check env", () => {
  const env = buildCheckEnv(profile(), { CI: "1", DEMO_TOKEN: "override" });
  assert.equal(env.DEMO_TOKEN, "override");
  assert.equal(env.CI, "1");
});

test("toolchainPath prepends existing toolchain directories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-toolchain-"));
  try {
    await mkdir(path.join(dir, "bin"));
    const toolchain = { tool: path.join(dir, "bin", "tool") };
    const result = toolchainPath(profile({ toolchain }), "/usr/bin:/bin");
    assert.ok(result.startsWith(path.join(dir, "bin")));
    assert.ok(result.includes("/usr/bin"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("envFilesFor uses configured files or the defaults", () => {
  assert.deepEqual(envFilesFor(profile()), [".env", ".env.local"]);
  const configured = profile({ repo: { ...profile().repo, envFiles: [".env", ".env.staging"] } });
  assert.deepEqual(envFilesFor(configured), [".env", ".env.staging"]);
});
