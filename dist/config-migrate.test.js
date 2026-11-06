import test from "node:test";
import assert from "node:assert/strict";
import { explainProfile, fillProfileFromTemplates, loadInitTemplates, migrateV3toV4, templateVersion } from "./config-templates.js";
import { validateConfig, validateV4Sections } from "./config.js";
import { DEFAULT_ENDPOINTS, validateEndpoints } from "./ziki-endpoints.js";
function v3Profile() {
    return {
        ziki: {
            baseUrl: "https://ziki.dev",
            projectId: "project_demo",
            projectSlug: "demo",
            platform: "desktop"
        },
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
        platformMatch: {},
        prompts: { dir: "prompts/generic" },
        pr: { templateFile: "prompts/generic/pr.md" },
        discovery: { enabled: false },
        workflow: { maxFiles: 5, maxLines: 400, branchPrefix: "fix", commitTypes: ["fix"], requireTests: true },
        limits: {
            maxActiveClaims: "auto",
            maxAttemptsPerTask: null,
            maxNetworkRetries: 5,
            networkRetryMinutes: 1,
            maxCyclesBeforeDiscovery: 6,
            maxOpenEscalations: null
        },
        pollSeconds: 120,
        memoryRefreshMinutes: 30,
        hitl: { enabled: true, defaultType: "question" }
    };
}
test("init templates load with version 4 meta", async () => {
    const templates = await loadInitTemplates();
    assert.equal(templateVersion(templates), 4);
    assert.ok(templates.transport, "transport section present");
    assert.ok(templates.operations, "operations section present");
    assert.ok(templates.queue, "queue section present");
});
test("init template endpoints pass endpoint validation", async () => {
    const templates = await loadInitTemplates();
    const errors = validateEndpoints(templates.endpoints, ["projectId", "projectSlug", "orgSlug", "platform", "project", "org"], "templates.endpoints");
    assert.deepEqual(errors, []);
});
test("fillProfileFromTemplates fills missing sections without overwriting", async () => {
    const templates = await loadInitTemplates();
    const { profile, filled } = fillProfileFromTemplates(v3Profile(), templates);
    assert.ok(filled.includes("transport"), "transport filled");
    assert.ok(filled.includes("operations"), "operations filled");
    assert.ok(filled.includes("queue"), "queue filled");
    const record = profile;
    assert.equal(record.transport.authScheme, "Bearer");
    // Explicit values win.
    const explicit = v3Profile();
    explicit.transport = { authScheme: "Custom" };
    const second = fillProfileFromTemplates(explicit, templates);
    assert.ok(!second.filled.includes("transport"), "explicit transport kept");
});
test("migrateV3toV4 stamps version 4 and fills every profile", async () => {
    const templates = await loadInitTemplates();
    const config = {
        version: 3,
        activeProfile: "demo",
        defaults: {},
        profiles: { demo: v3Profile() }
    };
    const { config: next, filled } = migrateV3toV4(config, templates);
    assert.equal(next.version, 4);
    assert.ok((filled["profiles.demo"] ?? []).includes("transport"));
    assert.ok((filled["profiles.demo"] ?? []).includes("operations"));
    // Idempotent: second migration fills nothing.
    const again = migrateV3toV4(next, templates);
    assert.deepEqual(again.filled, {});
});
test("validateV4Sections requires transport and operations in v4", () => {
    const bare = v3Profile();
    // v3 intent (no v4 sections) → no errors.
    assert.deepEqual(validateV4Sections(bare, "profiles.demo"), []);
    // v4 intent (transport present, operations missing) → error.
    const partial = { ...v3Profile(), transport: { authScheme: "Bearer" } };
    const errors = validateV4Sections(partial, "profiles.demo");
    assert.ok(errors.some((error) => error.includes("operations is required in v4")));
    // Bad method rejected.
    const bad = {
        ...v3Profile(),
        transport: { authScheme: "Bearer" },
        operations: { issues: { bid: { method: "" } } }
    };
    assert.ok(validateV4Sections(bad, "profiles.demo").some((error) => error.includes("method must be a non-empty string")));
});
test("template endpoints match the built-in registry (drift guard)", async () => {
    const templates = await loadInitTemplates();
    assert.deepEqual(templates.endpoints, DEFAULT_ENDPOINTS);
});
test("template operations reference real endpoints", async () => {
    const templates = await loadInitTemplates();
    const endpoints = templates.endpoints;
    const operations = templates.operations;
    for (const [group, names] of Object.entries(operations)) {
        for (const [name, op] of Object.entries(names)) {
            const endpoint = op.route ?? name;
            assert.ok(endpoints[group]?.[endpoint], `operations.${group}.${name} routes to missing endpoint ${group}.${endpoint}`);
        }
    }
});
test("v4 validation requires every config-driven section", async () => {
    const templates = await loadInitTemplates();
    const config = {
        version: 3,
        activeProfile: "demo",
        defaults: {},
        profiles: { demo: v3Profile() }
    };
    const { config: next } = migrateV3toV4(config, templates);
    const { validateV4Required } = await import("./config.js");
    assert.deepEqual(validateV4Required(next.profiles.demo, "profiles.demo"), []);
    const { transport: _dropped, ...rest } = next.profiles.demo;
    void _dropped;
    assert.ok(validateV4Required(rest, "profiles.demo").some((error) => error.includes("transport")));
});
test("migrated v3 config validates clean", async () => {
    const templates = await loadInitTemplates();
    const config = {
        version: 3,
        activeProfile: "demo",
        defaults: {},
        profiles: { demo: v3Profile() }
    };
    const { config: next } = migrateV3toV4(config, templates);
    const result = validateConfig(next);
    assert.deepEqual(result.errors, []);
});
test("explainProfile reports template provenance for missing sections", async () => {
    const templates = await loadInitTemplates();
    const entries = explainProfile("demo", v3Profile(), templates);
    const transport = entries.find((entry) => entry.path.endsWith(".transport"));
    assert.equal(transport?.source, "template");
    const explained = explainProfile("demo", { ...v3Profile(), transport: { authScheme: "Bearer" } }, templates);
    assert.equal(explained.find((entry) => entry.path.endsWith(".transport"))?.source, "explicit");
});
//# sourceMappingURL=config-migrate.test.js.map