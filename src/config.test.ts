import test from "node:test";
import assert from "node:assert/strict";
import type { JobConfig, WorkFeed } from "./types.js";
import { DEFAULT_LIMITS, deepMerge, migrateConfig, resolveModel, validateConfig } from "./config.js";
import { issueUrl, ideaUrl } from "./urls.js";
import { buildQueue, textMatchesPlatform } from "./queue.js";
import { parseTestFailures, protectedFiles, scanSecrets } from "./checks.js";
import { branchName, buildPrBody, summarizeChecks } from "./github.js";
import { getProvider } from "./providers/index.js";

function fixtureJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    ziki: {
      baseUrl: "https://ziki.dev",
      projectId: "project_demo",
      projectSlug: "demo",
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
    checks: [{ name: "test", command: "npm", args: ["test"], reporter: "json", baseline: true }],
    platformMatch: { keywords: ["desktop"] },
    prompts: { dir: "prompts/generic" },
    pr: { templateFile: "prompts/generic/pr.md", teamLead: "@lead" },
    discovery: { enabled: false },
    limits: { ...DEFAULT_LIMITS },
    pollSeconds: 120,
    memoryRefreshMinutes: 30,
    hitl: { enabled: true, defaultType: "question", notifyCommand: null },
    ...overrides
  };
}

test("deepMerge merges objects and replaces arrays", () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2] };
  const merged = deepMerge(base, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

test("validateConfig merges defaults", () => {
  const config = {
    version: 2 as const,
    activeJob: "demo",
    defaults: { executor: { provider: "opencode" as const, model: null }, limits: { ...DEFAULT_LIMITS }, pollSeconds: 120 },
    jobs: {
      demo: fixtureJob()
    }
  };
  const result = validateConfig(config);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("migrateConfig converts the old flat shape", () => {
  const migrated = migrateConfig({
    version: 1,
    activeJob: "zedu-desktop",
    jobs: {
      "zedu-desktop": {
        projectId: "project_zedu",
        projectSlug: "zedu",
        platform: "desktop",
        repo: {
          url: "git@github.com:zedu-vulcan/zedu-desktop.git",
          upstream: "https://github.com/zeduchat/zedu-desktop.git",
          base: "staging",
          githubRepo: "zeduchat/zedu-desktop",
          forkOwner: "zedu-vulcan",
          defaultBranch: "main",
          teamLead: "@lead"
        },
        agents: { workers: ["ZIKI_KEY1"], managers: ["ZIKI_KEY2"] },
        toolchain: { flutter: "flutter" }
      }
    }
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.jobs["zedu-desktop"]!.ziki.projectId, "project_zedu");
  assert.equal(migrated.jobs["zedu-desktop"]!.checks.length, 4);
  assert.equal(migrated.jobs["zedu-desktop"]!.prompts.dir, "prompts/zedu-desktop");
});

test("resolveModel prefers role over default", () => {
  const job = fixtureJob({
    executor: { provider: "claude", model: "default-model", models: { triage: "cheap-model" } }
  });
  assert.equal(resolveModel(job, "worker"), "default-model");
  assert.equal(resolveModel(job, "triage"), "cheap-model");
});

test("urls use the job base URL and slug", () => {
  const job = fixtureJob();
  assert.equal(issueUrl(job, { number: 42 }), "https://ziki.dev/demo/42");
  assert.equal(ideaUrl(job, { number: 7 }), "https://ziki.dev/demo/ideas/7");
});

test("textMatchesPlatform supports keywords and regex", () => {
  assert.equal(textMatchesPlatform(fixtureJob(), "A desktop bug"), true);
  assert.equal(textMatchesPlatform(fixtureJob(), "A web bug"), false);
  const regexJob = fixtureJob({ platformMatch: { regex: "\\bweb\\b" } });
  assert.equal(textMatchesPlatform(regexJob, "A web bug"), true);
});

test("buildQueue keeps the job's platform and skips recent keys", () => {
  const feed: WorkFeed = {
    project: { id: "p", slug: "demo", name: "Demo" },
    agent: { id: "a", name: "Agent", level: "working" },
    workUrl: "",
    pollAfterSeconds: 30,
    ask: [],
    inbox: { unread: 0, path: "" },
    counts: {},
    waiting: [],
    items: [
      {
        kind: "ready_issue",
        key: "desktop",
        title: "Desktop bug",
        detail: "",
        minimumRole: "working",
        canAct: true,
        issue: { id: "i1", number: 1, title: "Desktop bug", url: "" },
        actions: []
      },
      {
        kind: "ready_issue",
        key: "web",
        title: "Web bug",
        detail: "",
        minimumRole: "working",
        canAct: true,
        issue: { id: "i2", number: 2, title: "Web bug", url: "" },
        actions: []
      },
      {
        kind: "ready_issue",
        key: "recent",
        title: "Desktop recent",
        detail: "",
        minimumRole: "working",
        canAct: true,
        issue: { id: "i3", number: 3, title: "Desktop recent", url: "" },
        actions: []
      }
    ]
  };
  const queue = buildQueue({
    feed,
    job: fixtureJob(),
    platformNumbers: new Set([1, 3]),
    state: { recentFeedKeys: { recent: Date.now() } } as never
  });
  assert.deepEqual(
    queue.work.map((entry) => entry.issueNumber),
    [1]
  );
});

test("parseTestFailures reads flutter json output", () => {
  const output = [
    '{"type":"testStart","test":{"id":1,"name":"fails","url":"file:///repo/test/a_test.dart"}}',
    '{"type":"testDone","testID":1,"result":"failure","hidden":false}',
    '{"type":"testStart","test":{"id":2,"name":"passes","url":"file:///repo/test/a_test.dart"}}',
    '{"type":"testDone","testID":2,"result":"success","hidden":false}'
  ].join("\n");
  assert.deepEqual(parseTestFailures(output), ["test/a_test.dart::fails"]);
});

test("protectedFiles matches patterns", () => {
  assert.deepEqual(protectedFiles(["AGENTS.md", "src/a.ts"], ["AGENTS.md"]), ["AGENTS.md"]);
  assert.deepEqual(protectedFiles([".env", ".env.example"], [".env"]), [".env"]);
});

test("scanSecrets finds keys in added lines", () => {
  assert.equal(scanSecrets("+ZIKI_KEY1=secret\n+const ok = 1;").length, 1);
  assert.equal(scanSecrets("+const ok = 1;").length, 0);
});

test("branchName and summarizeChecks", () => {
  assert.equal(branchName({ number: 12 }, "Fix the thing"), "fix/12-fix-the-thing");
  assert.equal(summarizeChecks([]), "none");
  assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "passing");
  assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }]), "failing");
});

test("buildPrBody renders the job template", async () => {
  const body = await buildPrBody(fixtureJob(), {
    issue: { id: "i1", number: 42, title: "A bug", status: "open", substatus: "open", summary: "It breaks." },
    summary: "Fixed it.",
    description: "Changed a file.",
    testResults: "npm test: pass",
    testedAgainst: "fixture",
    howToTest: ["Run the app"],
    whatToExpect: "It works."
  });
  assert.match(body, /https:\/\/ziki\.dev\/demo\/42/);
  assert.match(body, /@lead/);
  assert.match(body, /Changed a file\./);
});

test("providers build the right commands", () => {
  const input = { prompt: "PROMPT", cwd: "/work", resultPath: "/result.json", model: "model-x" };

  const opencode = getProvider("opencode", fixtureJob()).build(input);
  assert.equal(opencode.command, "opencode");
  assert.deepEqual(opencode.args.slice(0, 5), ["run", "--auto", "--format", "default", "--dir"]);
  assert.ok(opencode.args.includes("/work"));
  assert.ok(opencode.args.includes("PROMPT"));

  const claude = getProvider("claude", fixtureJob({ executor: { provider: "claude" } })).build(input);
  assert.equal(claude.command, "claude");
  assert.ok(claude.args.includes("--dangerously-skip-permissions"));
  assert.ok(claude.args.includes("model-x"));

  const codex = getProvider("codex", fixtureJob({ executor: { provider: "codex" } })).build(input);
  assert.equal(codex.command, "codex");
  assert.ok(codex.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(codex.args.includes("-C"));

  const gemini = getProvider("gemini", fixtureJob({ executor: { provider: "gemini" } })).build(input);
  assert.equal(gemini.command, "gemini");
  assert.ok(gemini.args.includes("--yolo"));

  const customJob = fixtureJob({
    executor: {
      provider: "custom",
      command: "mycli",
      args: ["--prompt", "{{prompt}}", "--cwd", "{{cwd}}"]
    }
  });
  const custom = getProvider("custom", customJob).build(input);
  assert.equal(custom.command, "mycli");
  assert.deepEqual(custom.args, ["--prompt", "PROMPT", "--cwd", "/work"]);

  const stdinJob = fixtureJob({
    executor: { provider: "claude", promptMode: "stdin" }
  });
  const stdin = getProvider("claude", stdinJob).build(input);
  assert.equal(stdin.stdin, "PROMPT");
  assert.equal(stdin.args.includes("PROMPT"), false);
});
