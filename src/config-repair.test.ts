import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  EscalationRecord,
  HealthBlocker,
  ProfileConfig,
  ProfilePaths,
  ProjectSummary,
  State
} from "./types.js";
import { DEFAULT_LIMITS, DEFAULT_WORKFLOW, validateConfigPatch } from "./config.js";
import {
  APPROVAL_WORD,
  approveEscalation,
  applyRemoteAnswer,
  interpretHumanAnswer,
  isApprovalText,
  markEscalationExpired,
  openConfigEscalations,
  rejectEscalation
} from "./hitl.js";
import {
  applyConfigPatch,
  blockerCode,
  diagnoseProjectMismatch,
  matchReplacementProject,
  maxRoundsFor,
  repairConfigFor,
  strategyFor,
  supersedingPaths
} from "./config-repair.js";

function fixtureProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    ziki: {
      baseUrl: "https://ziki.dev",
      projectId: "project_old",
      projectSlug: "zedu",
      platform: "desktop",
      projectName: "Demo App"
    },
    stack: "Demo stack",
    repo: {
      url: "git@github.com:fork/demo.git",
      upstream: "https://github.com/owner/demo.git",
      base: "staging",
      githubRepo: "owner/demo",
      forkOwner: "fork",
      defaultBranch: "main",
      teamLead: "@lead",
      baselineFile: "lib/main.dart",
      protectedFiles: ["AGENTS.md"]
    },
    agents: { workers: ["ZIKI_KEY1"], managers: ["ZIKI_KEY2"] },
    executor: { provider: "opencode", model: null, timeoutMs: 1000, permissionMode: "auto" },
    toolchain: {},
    checks: [{ name: "test", command: "npm", args: ["test"] }],
    platformMatch: { keywords: ["desktop"] },
    prompts: { dir: "prompts/generic" },
    pr: { templateFile: "prompts/generic/pr.md", teamLead: "@lead" },
    discovery: { enabled: false },
    workflow: { ...DEFAULT_WORKFLOW },
    limits: { ...DEFAULT_LIMITS },
    pollSeconds: 120,
    memoryRefreshMinutes: 30,
    hitl: { enabled: true, defaultType: "question", notifyCommand: null },
    repair: {
      enabled: true,
      mutablePaths: ["ziki.projectId", "ziki.platformFilter"],
      allowNewKeys: ["ziki.platformFilter"],
      strategies: {
        "platform:not_found": { enabled: true, role: "configDoctor", maxRounds: 3 },
        "*:unknown_filter": { enabled: true, role: "configDoctor", maxRounds: 2 }
      }
    },
    ...overrides
  };
}

function fixtureProjects(): ProjectSummary[] {
  return [
    { id: "c17fc461d8ec6105f842b1c84", slug: "desktop", name: "Desktop", repoUrl: "https://github.com/zeduchat/zedu-desktop", openIssueCount: 322 },
    { id: "c9450e104412c6da7f67b64ee", slug: "mobile", name: "Mobile", repoUrl: "https://github.com/zeduchat/zedu-desktop", openIssueCount: 204 },
    { id: "ce1b58d64784f23dd73d1b74", slug: "web", name: "Web", repoUrl: "https://github.com/zeduchat/zedu-fe", openIssueCount: 41 }
  ];
}

function fixtureEscalation(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: "esc-1",
    issueId: null,
    issueNumber: null,
    issueTitle: null,
    type: "human_approval",
    body: "repair?",
    agentName: "config-doctor",
    createdAt: new Date().toISOString(),
    status: "open",
    answer: null,
    resolvedAt: null,
    kind: "config",
    strategy: "platform:not_found",
    configPatch: [{ path: "ziki.projectId", value: "c17fc461d8ec6105f842b1c84" }],
    decision: null,
    rounds: 1,
    remoteStatus: "open",
    appliedAt: null,
    previousId: null,
    ...overrides
  };
}

function fixtureBlocker(): HealthBlocker {
  return {
    id: "platform:not_found",
    component: "platform",
    code: "not_found",
    severity: "blocked",
    message: 'GET /api/v1/issues failed: Project not found.',
    since: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    attempts: 3,
    nextRetryAt: null,
    notifiedAt: null
  };
}

test("blockerCode joins component and code", () => {
  assert.equal(blockerCode(fixtureBlocker()), "platform:not_found");
  assert.equal(blockerCode(null), null);
});

test("repairConfigFor fills defaults", () => {
  const repair = repairConfigFor({} as ProfileConfig);
  assert.equal(repair.enabled, true);
  assert.ok(repair.mutablePaths.includes("ziki.projectId"));
  assert.deepEqual(repair.strategies["platform:not_found"], {
    enabled: true,
    role: "configDoctor",
    maxRounds: 3
  });
  assert.deepEqual(repair.strategies["*:unknown_filter"], {
    enabled: true,
    role: "configDoctor",
    maxRounds: 2
  });
});

test("strategyFor supports *:suffix wildcards", () => {
  const profile = fixtureProfile();
  const matched = strategyFor(profile, "feed:unknown_filter");
  assert.ok(matched);
  assert.equal(matched.role, "configDoctor");
  assert.equal(strategyFor(profile, "feed:something_else"), null);
});

test("strategyFor respects the master and per-strategy switches", () => {
  const profile = fixtureProfile();
  assert.ok(strategyFor(profile, "platform:not_found"));
  assert.equal(strategyFor(profile, "unknown:code"), null);
  assert.equal(
    strategyFor(fixtureProfile({ repair: { enabled: false } }), "platform:not_found"),
    null
  );
  assert.equal(
    strategyFor(
      fixtureProfile({ repair: { strategies: { "platform:not_found": { enabled: false } } } }),
      "platform:not_found"
    ),
    null
  );
});

test("maxRoundsFor falls back to 3", () => {
  assert.equal(maxRoundsFor(null), 3);
  assert.equal(maxRoundsFor({ maxRounds: 5 }), 5);
  assert.equal(maxRoundsFor({ maxRounds: 0 }), 3);
  assert.equal(maxRoundsFor({}), 3);
});

test("matchReplacementProject prefers the platform slug", () => {
  const matched = matchReplacementProject(fixtureProjects(), fixtureProfile());
  assert.ok(matched && "project" in matched);
  assert.equal(matched.project.id, "c17fc461d8ec6105f842b1c84");
  assert.match(matched.reason, /slug/);
});

test("matchReplacementProject falls back to repoUrl", () => {
  const profile = fixtureProfile();
  profile.ziki.platform = "nope";
  profile.repo.githubRepo = "zeduchat/zedu-fe";
  const matched = matchReplacementProject(fixtureProjects(), profile);
  assert.ok(matched && "project" in matched);
  assert.equal(matched.project.id, "ce1b58d64784f23dd73d1b74");
  assert.match(matched.reason, /repoUrl/);
});

test("matchReplacementProject reports ambiguity and misses", () => {
  const profile = fixtureProfile();
  profile.ziki.platform = "nope";
  profile.repo.githubRepo = "zeduchat/zedu-desktop";
  const matched = matchReplacementProject(fixtureProjects(), profile);
  assert.ok(matched && "ambiguous" in matched);
  assert.equal(matched.ambiguous.length, 2);

  const missing = matchReplacementProject([], fixtureProfile());
  assert.equal(missing, null);
});

test("diagnoseProjectMismatch proposes only differing identity fields", async () => {
  const profile = fixtureProfile();
  const client = {
    listProjects: async () => ({ items: fixtureProjects() }),
    readProject: async () => ({ id: "c17fc461d8ec6105f842b1c84", workUrl: "https://ziki.dev/zedu/desktop/work" })
  } as unknown as import("./ziki.js").ZikiClient;
  const diagnosis = await diagnoseProjectMismatch(client, profile);
  assert.ok(diagnosis.match);
  assert.deepEqual(diagnosis.ops.map((op) => op.path).sort(), ["ziki.orgSlug", "ziki.projectId", "ziki.projectSlug"]);
  assert.equal(
    diagnosis.ops.find((op) => op.path === "ziki.projectId")?.value,
    "c17fc461d8ec6105f842b1c84"
  );
  assert.equal(diagnosis.ops.find((op) => op.path === "ziki.orgSlug")?.value, "zedu");

  const aligned = fixtureProfile({
    ziki: {
      baseUrl: "https://ziki.dev",
      projectId: "c17fc461d8ec6105f842b1c84",
      projectSlug: "desktop",
      platform: "desktop",
      orgSlug: "zedu",
      projectName: "Desktop"
    }
  });
  const quiet = await diagnoseProjectMismatch(client, aligned);
  assert.deepEqual(quiet.ops, []);
  assert.match(quiet.detail, /already matches/);
  assert.equal(quiet.unparsedWorkUrl, null);
});

test("diagnoseProjectMismatch flags unparseable work URLs for human confirmation", async () => {
  const { diagnoseProjectMismatch: diagnose } = await import("./config-repair.js");
  const profile = fixtureProfile();
  const client = {
    listProjects: async () => ({ items: fixtureProjects() }),
    readProject: async () => ({ id: "c17fc461d8ec6105f842b1c84", workUrl: "https://ziki.dev/something-else" })
  } as unknown as import("./ziki.js").ZikiClient;
  const diagnosis = await diagnose(client, profile);
  assert.equal(diagnosis.unparsedWorkUrl, "https://ziki.dev/something-else");
  assert.match(diagnosis.detail, /human/);
  assert.ok(diagnosis.ops.every((op) => op.path === "ziki.projectId" || op.path === "ziki.projectSlug"));
});

test("validateConfigPatch accepts an allowlisted change", () => {
  const profile = fixtureProfile();
  const check = validateConfigPatch(
    profile,
    [{ path: "ziki.projectId", value: "c17fc461d8ec6105f842b1c84", reason: "rotation" }],
    repairConfigFor(profile)
  );
  assert.deepEqual(check, { ok: true, errors: [] });
});

test("validateConfigPatch rejects protected, unknown and mistyped paths", () => {
  const profile = fixtureProfile();
  const repair = repairConfigFor(profile);
  for (const op of [
    { path: "repo.pushMode", value: "upstream" },
    { path: "hitl.enabled", value: false },
    { path: "repair.enabled", value: false },
    { path: "executor.provider", value: "custom" }
  ]) {
    const check = validateConfigPatch(profile, [op], repair);
    assert.equal(check.ok, false, op.path);
    assert.match(check.errors.join(" "), /protected/);
  }
  const outside = validateConfigPatch(profile, [{ path: "workflow.maxFiles", value: 10 }], repair);
  assert.equal(outside.ok, false);
  assert.match(outside.errors.join(" "), /allowlist/);

  const unknown = validateConfigPatch(profile, [{ path: "ziki.unknown", value: 1 }], repair);
  assert.equal(unknown.ok, false);

  const mistyped = validateConfigPatch(profile, [{ path: "ziki.projectId", value: 42 }], repair);
  assert.equal(mistyped.ok, false);
  assert.match(mistyped.errors.join(" "), /type/);

  const empty = validateConfigPatch(profile, [], repair);
  assert.equal(empty.ok, false);
});

test("validateConfigPatch allows listed new keys", () => {
  const profile = fixtureProfile();
  const check = validateConfigPatch(
    profile,
    [{ path: "ziki.platformFilter", value: null }],
    repairConfigFor(profile)
  );
  assert.equal(check.ok, true);
});

test("isApprovalText matches the APPROVE convention", () => {
  assert.equal(isApprovalText("APPROVE this patch"), true);
  assert.equal(isApprovalText("approve with thanks"), true);
  assert.equal(isApprovalText("Looks good, apply it"), false);
  assert.equal(isApprovalText(null), false);
  assert.equal(APPROVAL_WORD, "APPROVE");
});

test("interpretHumanAnswer maps Ziki answers to decisions", () => {
  assert.equal(interpretHumanAnswer("open", null), null);
  assert.equal(interpretHumanAnswer("resolved", "APPROVE it"), "approved");
  assert.equal(interpretHumanAnswer("resolved", "why did this break?"), "needs_info");
  assert.equal(interpretHumanAnswer("dismissed", "dismissed, no"), "rejected");
});

test("applyRemoteAnswer keeps needs_info open and closes the rest", () => {
  const approved = fixtureEscalation();
  assert.equal(applyRemoteAnswer(approved, "resolved", "APPROVE"), "approved");
  assert.equal(approved.decision, "approved");
  assert.equal(approved.status, "open");

  const clarifying = fixtureEscalation({ id: "esc-2" });
  assert.equal(applyRemoteAnswer(clarifying, "resolved", "why?"), "needs_info");
  assert.equal(clarifying.decision, "needs_info");
  assert.equal(clarifying.status, "open");

  const rejected = fixtureEscalation({ id: "esc-3" });
  assert.equal(applyRemoteAnswer(rejected, "dismissed", "dismissed"), "rejected");
  assert.equal(rejected.status, "dismissed");
});

function fixtureState(): State {
  return { escalations: {} } as State;
}

test("approve/reject helpers gate on kind and status", () => {
  const state = fixtureState();
  state.escalations["esc-1"] = fixtureEscalation();
  assert.deepEqual(approveEscalation(state, "esc-1", "APPROVE via CLI").ok, true);
  assert.equal(state.escalations["esc-1"]!.decision, "approved");

  state.escalations["esc-2"] = fixtureEscalation({ id: "esc-2" });
  assert.deepEqual(rejectEscalation(state, "esc-2").ok, true);
  assert.equal(state.escalations["esc-2"]!.status, "dismissed");

  assert.equal(approveEscalation(state, "missing").ok, false);
  // Re-confirming an approved escalation is allowed (idempotent).
  assert.equal(approveEscalation(state, "esc-1").ok, true);
  state.escalations["esc-9"] = fixtureEscalation({ id: "esc-9", kind: "issue" });
  assert.equal(approveEscalation(state, "esc-9").ok, false);
});

test("markEscalationExpired and openConfigEscalations", () => {
  const state = fixtureState();
  state.escalations["esc-1"] = fixtureEscalation();
  state.escalations["esc-2"] = fixtureEscalation({ id: "esc-2", strategy: "other:code" });
  assert.equal(markEscalationExpired(state, "esc-1", "too many rounds"), true);
  assert.equal(state.escalations["esc-1"]!.status, "expired");
  assert.equal(markEscalationExpired(state, "esc-1", "again"), false);
  const open = openConfigEscalations(state, "other:code");
  assert.deepEqual(open.map((entry) => entry.id), ["esc-2"]);
});

test("applyConfigPatch persists an approved patch with backup", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aw-repair-"));
  const previousHome = process.env.AUTO_WORK_CONFIG_DIR;
  process.env.AUTO_WORK_CONFIG_DIR = dir;
  try {
    const { loadConfig } = await import("./config.js");
    const profile = fixtureProfile();
    const file = path.join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 3, activeProfile: "demo", profiles: { demo: profile } }, null, 2)
    );
    writeFileSync(path.join(dir, "env"), "ZIKI_KEY1=test-key-1\nZIKI_KEY2=test-key-2\n");
    const before = await loadConfig();
    assert.equal(before.profiles["demo"]?.ziki.projectId, "project_old");

    const { profilePaths } = await import("./platform/paths.js");
    const paths = { ...profilePaths("demo"), stateDir: dir } as ProfilePaths;
    const result = await applyConfigPatch(
      before,
      "demo",
      paths,
      [{ path: "ziki.projectId", value: "c17fc461d8ec6105f842b1c84", reason: "rotation" }]
    );
    assert.equal(result.ok, true);
    assert.ok(result.backupFile);

    const after = await loadConfig();
    assert.equal(after.profiles["demo"]?.ziki.projectId, "c17fc461d8ec6105f842b1c84");
  } finally {
    if (previousHome === undefined) delete process.env.AUTO_WORK_CONFIG_DIR;
    else process.env.AUTO_WORK_CONFIG_DIR = previousHome;
  }
});

test("applyConfigPatch refuses invalid patches without writing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aw-repair-"));
  const previousHome = process.env.AUTO_WORK_CONFIG_DIR;
  process.env.AUTO_WORK_CONFIG_DIR = dir;
  try {
    const profile = fixtureProfile();
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ version: 3, activeProfile: "demo", profiles: { demo: profile } }, null, 2)
    );
    writeFileSync(path.join(dir, "env"), "ZIKI_KEY1=test-key-1\nZIKI_KEY2=test-key-2\n");
    const { profilePaths } = await import("./platform/paths.js");
    const paths = { ...profilePaths("demo"), stateDir: dir } as ProfilePaths;
    const { loadConfig } = await import("./config.js");
    const before = await loadConfig();
    const result = await applyConfigPatch(before, "demo", paths, [
      { path: "repo.pushMode", value: "upstream" }
    ]);
    assert.equal(result.ok, false);
    const after = await loadConfig();
    assert.equal(after.profiles["demo"]?.ziki.projectId, "project_old");
  } finally {
    if (previousHome === undefined) delete process.env.AUTO_WORK_CONFIG_DIR;
    else process.env.AUTO_WORK_CONFIG_DIR = previousHome;
  }
});

test("diagnoseUnknownFilter matches identity and single-platform cases", async () => {
  const { diagnoseUnknownFilter } = await import("./config-repair.js");
  const profile = fixtureProfile();
  const client = {
    platforms: async () => ({ items: [{ slug: "desktop" }, { slug: "mobile" }] })
  } as unknown as import("./ziki.js").ZikiClient;

  const resolving = await diagnoseUnknownFilter(client, profile);
  assert.equal(resolving.resolves, true);
  assert.deepEqual(resolving.suggested, []);

  const custom = fixtureProfile();
  custom.ziki.platformFilter = "general";
  const reset = await diagnoseUnknownFilter(client, custom);
  assert.equal(reset.resolves, false);
  assert.deepEqual(reset.suggested, [
    {
      path: "ziki.platformFilter",
      value: "desktop",
      reason: 'custom filter "general" is unknown; identity "desktop" still resolves'
    }
  ]);

  const solo = {
    platforms: async () => ({ items: [{ slug: "web" }] })
  } as unknown as import("./ziki.js").ZikiClient;
  const single = await diagnoseUnknownFilter(solo, custom);
  assert.equal(single.suggested[0]?.value, "web");

  const failing = {
    platforms: async () => {
      throw new Error("boom");
    }
  } as unknown as import("./ziki.js").ZikiClient;
  const failed = await diagnoseUnknownFilter(failing, profile);
  assert.equal(failed.resolves, false);
  assert.match(failed.reason, /boom/);
});

test("supersedingPaths requires strict superset growth", () => {
  const toOps = (paths: string[]) => paths.map((path) => ({ path, value: "x" }));
  assert.deepEqual(supersedingPaths(toOps(["ziki.projectId"]), toOps(["ziki.projectId", "ziki.orgSlug"])), [
    "ziki.orgSlug"
  ]);
  assert.equal(supersedingPaths(toOps(["ziki.projectId"]), toOps(["ziki.projectId"])), null);
  assert.equal(supersedingPaths(toOps(["ziki.projectId"]), toOps(["ziki.orgSlug"])), null);
  assert.equal(supersedingPaths(toOps(["ziki.projectId"]), []), null);
  // No pending patch + a real diagnosis fills the gap.
  assert.deepEqual(supersedingPaths(null, toOps(["ziki.projectId"])), ["ziki.projectId"]);
  assert.deepEqual(supersedingPaths([], toOps(["ziki.projectId"])), ["ziki.projectId"]);
});

test("loadPrompt resolves the config-doctor template", async () => {
  const { loadPrompt } = await import("./agent.js");
  const text = await loadPrompt(fixtureProfile(), "configDoctor");
  assert.match(text, /configPatch/);
});
