import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, DEFAULT_WORKFLOW, deepMerge, defaultConfig, resolveModel, validateConfig, validateConfigPatch } from "./config.js";
import { repairConfigFor } from "./config-repair.js";
import { issueUrl, ideaUrl } from "./urls.js";
import { buildQueue, textMatchesPlatform } from "./queue.js";
import { parseTestFailures, protectedFiles, scanSecrets } from "./checks.js";
import { branchName, buildPrBody, summarizeChecks } from "./github.js";
import { getProvider } from "./providers/index.js";
import { assignRoles, formatKeyTable, projectSummary } from "./keys.js";
function fixtureProfile(overrides = {}) {
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
        workflow: { ...DEFAULT_WORKFLOW },
        limits: { ...DEFAULT_LIMITS },
        pollSeconds: 120,
        memoryRefreshMinutes: 30,
        hitl: { enabled: true, defaultType: "question", notifyCommand: null },
        urls: {
            envSuffixes: { on_dev: "dev", on_staging: "staging", on_prod: "prod" },
            issuePath: "/{org?}/{project}/{issue}",
            ideaPath: "/{org?}/{project}/ideas/{idea}",
            inboxPath: "/inbox"
        },
        queue: {
            priorities: { ready_issue: 6 },
            buckets: { owner: [], work: ["ready_issue"], review: [], aux: [] },
            noIssueKinds: [],
            blockedStatuses: ["done"],
            activeStatuses: ["working", "claimed"],
            recentMs: 1800000
        },
        ...overrides
    };
}
test("deepMerge merges objects and replaces arrays", () => {
    const base = { a: { b: 1, c: 2 }, list: [1, 2] };
    const merged = deepMerge(base, { a: { c: 3 }, list: [9] });
    assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});
test("defaultConfig is a version 4 skeleton", () => {
    const config = defaultConfig();
    assert.equal(config.version, 4);
    assert.equal(config.activeProfile, "");
    assert.deepEqual(config.profiles, {});
});
test("validateConfig merges defaults", () => {
    const config = {
        version: 3,
        activeProfile: "demo",
        defaults: {
            executor: { provider: "opencode", model: null },
            limits: { ...DEFAULT_LIMITS },
            pollSeconds: 120
        },
        profiles: {
            demo: fixtureProfile()
        }
    };
    const result = validateConfig(config);
    assert.equal(result.ok, true, result.errors.join("; "));
});
test("validateConfig allows managers-only or workers-only profiles", () => {
    const managersOnly = validateConfig({
        version: 3,
        activeProfile: "demo",
        profiles: { demo: fixtureProfile({ agents: { workers: [], managers: ["ZIKI_KEY1"] } }) }
    });
    assert.equal(managersOnly.ok, true, managersOnly.errors.join("; "));
    const workersOnly = validateConfig({
        version: 3,
        activeProfile: "demo",
        profiles: { demo: fixtureProfile({ agents: { workers: ["ZIKI_KEY2"], managers: [] } }) }
    });
    assert.equal(workersOnly.ok, true, workersOnly.errors.join("; "));
});
test("validateConfig rejects a non-v3 config", () => {
    const result = validateConfig({
        version: 2,
        activeJob: "demo",
        jobs: { demo: fixtureProfile() }
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("version must be 3")));
});
test("assignRoles sends working keys to workers and managers to managers", () => {
    const roles = assignRoles([
        { envName: "ZIKI_KEY1", key: "", ok: true, level: "manager" },
        { envName: "ZIKI_KEY2", key: "", ok: true, level: "working" },
        { envName: "ZIKI_KEY3", key: "", ok: true, level: "merger" },
        { envName: "ZIKI_KEY4", key: "", ok: true, level: "working" },
        { envName: "ZIKI_BAD", key: "", ok: false, error: "401" }
    ]);
    assert.deepEqual(roles.workers, ["ZIKI_KEY2", "ZIKI_KEY4"]);
    assert.deepEqual(roles.managers, ["ZIKI_KEY1", "ZIKI_KEY3"]);
});
test("projectSummary picks the most common key project", () => {
    const summary = projectSummary([
        { envName: "A", key: "", ok: true, projectId: "p1", projectSlug: "one" },
        { envName: "B", key: "", ok: true, projectId: "p2", projectSlug: "two" },
        { envName: "C", key: "", ok: true, projectId: "p2", projectSlug: "two" }
    ]);
    assert.deepEqual(summary, { id: "p2", slug: "two", name: undefined });
});
test("formatKeyTable marks invalid keys", () => {
    const table = formatKeyTable([
        { envName: "ZIKI_KEY1", key: "", ok: true, agent: "Duncan", level: "manager", projectSlug: "zedu" },
        { envName: "ZIKI_BAD", key: "", ok: false, error: "401" }
    ]);
    assert.match(table, /ZIKI_KEY1/);
    assert.match(table, /INVALID/);
});
test("resolveModel prefers role over default", () => {
    const profile = fixtureProfile({
        executor: { provider: "claude", model: "default-model", models: { triage: "cheap-model" } }
    });
    assert.equal(resolveModel(profile, "worker"), "default-model");
    assert.equal(resolveModel(profile, "triage"), "cheap-model");
});
test("urls use the profile base URL and slug", () => {
    const profile = fixtureProfile();
    assert.equal(issueUrl(profile, { number: 42 }), "https://ziki.dev/demo/42");
    assert.equal(ideaUrl(profile, { number: 7 }), "https://ziki.dev/demo/ideas/7");
});
test("textMatchesPlatform supports keywords and regex", () => {
    assert.equal(textMatchesPlatform(fixtureProfile(), "A desktop bug"), true);
    assert.equal(textMatchesPlatform(fixtureProfile(), "A web bug"), false);
    const regexProfile = fixtureProfile({ platformMatch: { regex: "\\bweb\\b" } });
    assert.equal(textMatchesPlatform(regexProfile, "A web bug"), true);
});
test("buildQueue keeps the profile's platform and skips recent keys", () => {
    const feed = {
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
        profile: fixtureProfile(),
        platformNumbers: new Set([1, 3]),
        state: { recentFeedKeys: { recent: Date.now() } }
    });
    assert.deepEqual(queue.work.map((entry) => entry.issueNumber), [1]);
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
    const patterns = ["ZIKI_KEY[A-Z0-9_]*\\s*=\\s*\\S+"];
    assert.equal(scanSecrets("+ZIKI_KEY1=secret\n+const ok = 1;", patterns).length, 1);
    assert.equal(scanSecrets("+const ok = 1;", patterns).length, 0);
});
test("branchName and summarizeChecks", () => {
    assert.equal(branchName({ number: 12 }, "Fix the thing", "fix"), "fix/12-fix-the-thing");
    const states = { passing: "passing", failing: "failing", pending: "pending", none: "none" };
    assert.equal(summarizeChecks([], states), "none");
    assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }], states), "passing");
    assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }], states), "failing");
    assert.throws(() => summarizeChecks([], null), /check states/);
});
test("buildPrBody renders the profile template", async () => {
    const body = await buildPrBody(fixtureProfile(), {
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
    const opencode = getProvider("opencode", fixtureProfile()).build(input);
    assert.equal(opencode.command, "opencode");
    assert.deepEqual(opencode.args.slice(0, 5), ["run", "--auto", "--format", "json", "--dir"]);
    assert.ok(opencode.args.includes("/work"));
    assert.ok(opencode.args.includes("PROMPT"));
    const claude = getProvider("claude", fixtureProfile({ executor: { provider: "claude" } })).build(input);
    assert.equal(claude.command, "claude");
    assert.ok(claude.args.includes("--dangerously-skip-permissions"));
    assert.ok(claude.args.includes("model-x"));
    const codex = getProvider("codex", fixtureProfile({ executor: { provider: "codex" } })).build(input);
    assert.equal(codex.command, "codex");
    assert.ok(codex.args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(codex.args.includes("-C"));
    const gemini = getProvider("gemini", fixtureProfile({ executor: { provider: "gemini" } })).build(input);
    assert.equal(gemini.command, "gemini");
    assert.ok(gemini.args.includes("--yolo"));
    const customProfile = fixtureProfile({
        executor: {
            provider: "custom",
            command: "mycli",
            args: ["--prompt", "{{prompt}}", "--cwd", "{{cwd}}"]
        }
    });
    const custom = getProvider("custom", customProfile).build(input);
    assert.equal(custom.command, "mycli");
    assert.deepEqual(custom.args, ["--prompt", "PROMPT", "--cwd", "/work"]);
    const stdinProfile = fixtureProfile({
        executor: { provider: "claude", promptMode: "stdin" }
    });
    const stdin = getProvider("claude", stdinProfile).build(input);
    assert.equal(stdin.stdin, "PROMPT");
    assert.equal(stdin.args.includes("PROMPT"), false);
});
test("run limits and concurrency have working defaults", () => {
    assert.equal(DEFAULT_LIMITS.maxRuntimeMinutes, null);
    assert.equal(DEFAULT_LIMITS.maxAttemptsPerTask, null);
    assert.equal(DEFAULT_LIMITS.maxOpenEscalations, null);
    assert.equal(DEFAULT_LIMITS.maxCycles, null);
    assert.equal(DEFAULT_LIMITS.maxConcurrentDeliveries, "auto");
    assert.equal(DEFAULT_LIMITS.maxConcurrentReviews, "auto");
    assert.equal(DEFAULT_LIMITS.maxConcurrentAux, "auto");
    assert.equal(DEFAULT_LIMITS.maxConcurrentFollowUps, "auto");
    assert.equal(DEFAULT_LIMITS.maxConcurrentAgents, "auto");
    assert.equal(DEFAULT_LIMITS.maxActiveClaims, "auto");
    assert.equal(DEFAULT_LIMITS.maxTokensPerRun, null);
    assert.equal(DEFAULT_LIMITS.tokenWarnPercent, 80);
    assert.equal(DEFAULT_LIMITS.providerRetryMinutes, 15);
    assert.equal(defaultConfig().doctor?.minFreeGb, 3);
});
test("validateConfig allows working-only profiles and warns", () => {
    const profile = fixtureProfile({ agents: { workers: ["ZIKI_KEY1"], managers: [] } });
    const config = { version: 3, activeProfile: "demo", profiles: { demo: profile } };
    const result = validateConfig(config);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => warning.includes("manager")));
});
test("deepMerge keeps limit defaults when a profile overrides one field", () => {
    const merged = deepMerge({ limits: { ...DEFAULT_LIMITS } }, { limits: { maxCycles: 3 } });
    assert.equal(merged.limits.maxCycles, 3);
    assert.equal(merged.limits.maxRuntimeMinutes, null);
});
test("workflow values are validated", () => {
    const profile = fixtureProfile({ workflow: { ...DEFAULT_WORKFLOW, maxFiles: 0 } });
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("workflow.maxFiles")));
});
test("workflow is optional in raw configs and defaults are filled by loadProfile", () => {
    const profile = fixtureProfile();
    delete profile.workflow;
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => warning.includes("workflow")));
});
test("validateConfig rejects a fork owner that does not match the clone URL", () => {
    const profile = fixtureProfile({
        repo: { ...fixtureProfile().repo, forkOwner: "someone-else" }
    });
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("does not match repo.forkOwner")));
});
test("validateConfig accepts an explicit upstream push mode", () => {
    const base = fixtureProfile();
    const profile = fixtureProfile({
        repo: {
            ...base.repo,
            url: "git@github.com:owner/demo.git",
            forkOwner: "owner",
            pushMode: "upstream"
        }
    });
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, true, result.errors.join("; "));
});
test("validateConfig rejects upstream mode with a fork owner", () => {
    const profile = fixtureProfile({
        repo: { ...fixtureProfile().repo, url: "git@github.com:owner/demo.git", forkOwner: "fork", pushMode: "upstream" }
    });
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("must equal the upstream owner")));
});
test("validateConfig accepts the default repair section", () => {
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: fixtureProfile() } });
    assert.equal(result.ok, true, result.errors.join("; "));
});
test("validateConfig rejects protected repair paths even when explicit", () => {
    for (const bad of ["repo.pushMode", "hitl.enabled", "repair.enabled", "executor.provider", "agents.workers"]) {
        const profile = fixtureProfile({ repair: { mutablePaths: [bad] } });
        const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
        assert.equal(result.ok, false, bad);
        assert.ok(result.errors.some((error) => error.includes("never be agent-modified")), bad);
    }
});
test("validateConfig rejects malformed repair strategies", () => {
    const profile = fixtureProfile({
        repair: {
            strategies: {
                "platform:not_found": {
                    enabled: true,
                    role: "",
                    maxRounds: 0,
                    match: "slug"
                }
            }
        }
    });
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 3, result.errors.join("; "));
});
test("defaultConfig is a literal-free v4 skeleton", () => {
    const config = defaultConfig();
    assert.equal(config.version, 4);
    assert.deepEqual(config.defaults, {});
    assert.deepEqual(config.profiles, {});
    assert.equal(config.doctor?.minFreeGb, 3);
});
test("validateConfig rejects absolute endpoint URLs", () => {
    const profile = fixtureProfile({
        ziki: { ...fixtureProfile().ziki, endpoints: { issues: { list: "https://evil.test/x" } } }
    });
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("scheme or host")));
});
test("validateConfigPatch accepts endpoint, vars and orgSlug ops", () => {
    const profile = fixtureProfile();
    const repair = repairConfigFor(profile);
    const check = validateConfigPatch(profile, [
        { path: "ziki.endpoints.issues.list", value: "/api/v2/issues", reason: "v2" },
        { path: "ziki.vars.team", value: "t1", reason: "new var" },
        { path: "ziki.orgSlug", value: "zedu", reason: "org" }
    ], repair);
    assert.deepEqual(check.errors, []);
    assert.equal(check.ok, true);
});
test("validateConfigPatch rejects unknown template vars and protected paths", () => {
    const profile = fixtureProfile();
    const repair = repairConfigFor(profile);
    const bad = validateConfigPatch(profile, [{ path: "ziki.endpoints.issues.list", value: "/api/v1/{nope}/issues" }], repair);
    assert.equal(bad.ok, false);
    const secret = validateConfigPatch(profile, [{ path: "ziki.apiKey", value: "x" }], repair);
    assert.equal(secret.ok, false);
});
test("validateConfig accepts timing, statuses and retry overrides", () => {
    const profile = fixtureProfile({
        timing: { offlineWatchMs: 120_000 },
        health: { retryMs: { "platform:not_found": 60_000 } },
        statuses: { workable: ["open"], terminal: ["closed"] }
    });
    const result = validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: profile } });
    assert.equal(result.ok, true, result.errors.join("; "));
});
test("validateConfig rejects bad timing, statuses and retry overrides", () => {
    const badTiming = fixtureProfile({ timing: { offlineWatchMs: 1 } });
    assert.equal(validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: badTiming } }).ok, false);
    const badStatus = fixtureProfile({ statuses: { workable: "open" } });
    assert.equal(validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: badStatus } }).ok, false);
    const badRetry = fixtureProfile({ health: { retryMs: { x: -5 } } });
    assert.equal(validateConfig({ version: 3, activeProfile: "demo", profiles: { demo: badRetry } }).ok, false);
});
test("validateConfigPatch enforces timing floors for agent proposals", () => {
    const profile = fixtureProfile();
    const repair = repairConfigFor(profile);
    const tooFast = validateConfigPatch(profile, [{ path: "timing.offlineWatchMs", value: 1000 }], repair);
    assert.equal(tooFast.ok, false);
    const ok = validateConfigPatch(profile, [{ path: "timing.offlineWatchMs", value: 300_000 }], repair);
    assert.equal(ok.ok, true, ok.errors.join("; "));
    const forbidden = validateConfigPatch(profile, [{ path: "ziki.heartbeatMs", value: 1000 }], repair);
    assert.equal(forbidden.ok, false);
});
//# sourceMappingURL=config.test.js.map