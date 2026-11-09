import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diagnoseForCode, runRepairStateMachine, save, verifyEndpointOps } from "./orchestrator.js";
import { strategyFor } from "./config-repair.js";
import { loadInitTemplates, fillProfileFromTemplates } from "./config-templates.js";
import { ZikiError } from "./ziki.js";
const templates = await loadInitTemplates();
function filledProfile() {
    const base = {
        ziki: { baseUrl: "https://ziki.dev", projectId: "c17fc4", projectSlug: "desktop", platform: "desktop", orgSlug: "zedu" },
        repo: { url: "", upstream: "", base: "main", githubRepo: "o/r", forkOwner: "f", defaultBranch: "main" },
        agents: { workers: [], managers: [] },
        executor: { provider: "opencode" },
        toolchain: {},
        checks: [],
        platformMatch: {},
        prompts: { dir: "prompts/generic" },
        pr: { templateFile: "prompts/generic/pr.md" },
        discovery: { enabled: false },
        workflow: { maxFiles: 5, maxLines: 400, branchPrefix: "fix", commitTypes: ["fix"], requireTests: true },
        limits: { maxActiveClaims: "auto", maxAttemptsPerTask: null, maxNetworkRetries: 5, networkRetryMinutes: 1, maxCyclesBeforeDiscovery: 6, maxOpenEscalations: null },
        pollSeconds: 120,
        memoryRefreshMinutes: 30,
        hitl: { enabled: true, defaultType: "question" }
    };
    return fillProfileFromTemplates(base, templates).profile;
}
function fakeCtx(client, profile) {
    const dir = mkdtempSync(path.join(tmpdir(), "aw-repair-"));
    return {
        profile,
        primary: { name: "agent", key: "k", client },
        profilePaths: { stateDir: dir, historyFile: path.join(dir, "history.jsonl") },
        state: { escalations: {}, tasks: {}, noteDedupe: {}, recentFeedKeys: {}, counters: {}, memory: {}, feedEtags: {}, apiContracts: {}, activePids: [], health: { state: "healthy", blockers: {}, lastCheckAt: null }, run: {}, lastCycle: null, lastRun: null },
        logger: { info: () => { }, warn: () => { }, error: () => { }, debug: () => { } }
    };
}
function blocker(message, details) {
    return {
        id: "feed:unexpected_response_shape",
        component: "feed",
        code: "unexpected_response_shape",
        severity: "warning",
        message,
        details,
        since: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        attempts: 1,
        nextRetryAt: null,
        notifiedAt: null
    };
}
test("feed-shape failure with matching identity reaches the agent (no early wait)", async () => {
    const profile = filledProfile();
    const client = {
        listProjects: async () => ({ items: [{ id: "c17fc4", slug: "desktop", name: "Desktop" }] }),
        readProject: async () => ({ workUrl: "https://ziki.dev/zedu/desktop/work" })
    };
    const ctx = fakeCtx(client, profile);
    const result = await diagnoseForCode(ctx, "feed:unexpected_response_shape", blocker("GET /zedu/work failed: unexpected response shape", { expected: "feed", preview: "<!DOCTYPE html>" }));
    // Regression: this used to return done:"wait" (agent never ran). Now the
    // deterministic part only contributes evidence; the agent investigates.
    assert.equal(result.done, null);
    assert.match(result.summary, /Agent investigation required/);
    assert.ok(result.evidence.some((line) => line.includes("<!DOCTYPE html>")));
    rmSync(ctx.profilePaths.stateDir, { recursive: true, force: true });
});
test("verifyEndpointOps drops proven-missing routes and keeps the rest", async () => {
    const profile = filledProfile();
    const client = {
        request: async (method, pathname) => {
            if (pathname === "/api/v1/nope") {
                throw new ZikiError("GET /api/v1/nope failed: No such API route.", {
                    status: 404,
                    body: { error: "not_found", message: "No such API route. See /llms.txt." },
                    method,
                    path: pathname
                });
            }
            if (pathname === "/api/v1/issues")
                return { items: [] };
            throw new ZikiError(`GET ${pathname} failed`, { status: 500, body: {}, method, path: pathname });
        }
    };
    const ctx = fakeCtx(client, profile);
    const ops = [
        { path: "ziki.endpoints.issues.nope", value: "/api/v1/nope" },
        { path: "ziki.endpoints.issues.list", value: "/api/v1/issues" },
        { path: "ziki.endpoints.issues.get", value: "/api/v1/issues/{issue}" },
        { path: "queue.priorities.brand_new_kind", value: 40 }
    ];
    const { ops: kept, notes } = await verifyEndpointOps(ctx, ops);
    assert.deepEqual(kept.map((op) => op.path).sort(), [
        "queue.priorities.brand_new_kind",
        "ziki.endpoints.issues.get",
        "ziki.endpoints.issues.list"
    ]);
    assert.ok(notes.some((note) => note.includes("dropped")), notes.join(" | "));
    assert.ok(notes.some((note) => note.includes("unverifiable")), notes.join(" | "));
    rmSync(ctx.profilePaths.stateDir, { recursive: true, force: true });
});
test("config-doctor prompt authorizes read-only public probing, never writes", async () => {
    const { loadPrompt } = await import("./agent.js");
    const { loadInitTemplates: load } = await import("./config-templates.js");
    void load;
    const profile = filledProfile();
    const text = await loadPrompt({ ...profile, prompts: { dir: "prompts/generic" } }, "configDoctor");
    assert.match(text, /unauthenticated public URLs/);
    assert.match(text, /AW_RESULT_JSON/);
    assert.match(text, /never invent IDs, URLs, or slugs/);
});
function repairCtx(client, profile) {
    const dir = mkdtempSync(path.join(tmpdir(), "aw-repair-"));
    return {
        profile,
        primary: { name: "agent", key: "k", client },
        profilePaths: {
            stateDir: dir,
            historyFile: path.join(dir, "history.jsonl"),
            needsHumanFile: path.join(dir, "NEEDS-HUMAN.md")
        },
        state: { escalations: {}, tasks: {}, noteDedupe: {}, recentFeedKeys: {}, counters: {}, memory: {}, feedEtags: {}, apiContracts: {}, activePids: [], health: { state: "healthy", blockers: {}, lastCheckAt: null }, run: {}, lastCycle: null, lastRun: null },
        logger: { info: () => { }, warn: () => { }, error: () => { }, debug: () => { } },
        configMtimeMs: 111
    };
}
function dismissedEscalation(id, strategy) {
    return {
        id,
        issueId: null,
        issueNumber: null,
        issueTitle: null,
        type: "human_approval",
        body: "repair?",
        agentName: "agent",
        createdAt: new Date().toISOString(),
        status: "dismissed",
        answer: "no",
        resolvedAt: new Date().toISOString(),
        kind: "config",
        strategy,
        configPatch: [{ path: "queue.priorities.some_kind", value: 99 }],
        decision: "rejected",
        rounds: 1,
        remoteStatus: "dismissed",
        appliedAt: null,
        previousId: null
    };
}
function strategyBlocker(code, component, short) {
    return {
        id: code,
        component,
        code: short,
        severity: "warning",
        message: `${code} failed`,
        since: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        attempts: 1,
        nextRetryAt: null,
        notifiedAt: null
    };
}
test("a rejected proposal parks at a visible dead-end instead of re-proposing", async () => {
    const profile = filledProfile();
    const client = { inbox: async () => ({ items: [] }) };
    const ctx = repairCtx(client, profile);
    ctx.state.escalations["esc-rej"] = dismissedEscalation("esc-rej", "platform:unknown_kind");
    const strategy = strategyFor(profile, "platform:unknown_kind");
    assert.ok(strategy, "template strategy *:unknown_kind must exist");
    const outcome = await runRepairStateMachine(ctx, "platform:unknown_kind", strategyBlocker("platform:unknown_kind", "platform", "unknown_kind"), strategy);
    assert.equal(outcome, "wait");
    const deadEnd = ctx.state.health.blockers["config:repair_dead_end"];
    assert.ok(deadEnd, "dead-end health item must be recorded");
    assert.equal(deadEnd.details?.strategy, "platform:unknown_kind");
    // A second cycle must stay parked without filing a new escalation.
    const again = await runRepairStateMachine(ctx, "platform:unknown_kind", strategyBlocker("platform:unknown_kind", "platform", "unknown_kind"), strategy);
    assert.equal(again, "wait");
    assert.deepEqual(Object.keys(ctx.state.escalations), ["esc-rej"]);
    rmSync(ctx.profilePaths.stateDir, { recursive: true, force: true });
});
test("maxRounds exhaustion parks at a dead-end instead of looping", async () => {
    const profile = filledProfile();
    const client = {
        inbox: async () => ({ items: [] }),
        getEscalation: async () => ({ escalation: { status: "open", resolution: null, resolvedAt: null } })
    };
    const ctx = repairCtx(client, profile);
    ctx.state.escalations["esc-info"] = {
        ...dismissedEscalation("esc-info", "platform:unknown_kind"),
        status: "open",
        answer: null,
        resolvedAt: null,
        decision: "needs_info",
        remoteStatus: "open",
        rounds: 2
    };
    const strategy = strategyFor(profile, "platform:unknown_kind");
    assert.ok(strategy);
    const outcome = await runRepairStateMachine(ctx, "platform:unknown_kind", strategyBlocker("platform:unknown_kind", "platform", "unknown_kind"), strategy);
    assert.equal(outcome, "wait");
    assert.equal(ctx.state.escalations["esc-info"].status, "expired");
    assert.equal(ctx.state.health.blockers["config:repair_dead_end"]?.details?.strategy, "platform:unknown_kind");
    rmSync(ctx.profilePaths.stateDir, { recursive: true, force: true });
});
test("feed:not_found runs the project-rotation diagnosis like platform:not_found", async () => {
    const profile = filledProfile();
    const client = {
        listProjects: async () => ({ items: [{ id: "c17fc4", slug: "desktop", name: "Desktop" }] }),
        readProject: async () => ({ workUrl: "https://ziki.dev/zedu/desktop/work" })
    };
    const ctx = repairCtx(client, profile);
    const result = await diagnoseForCode(ctx, "feed:not_found", strategyBlocker("feed:not_found", "feed", "not_found"));
    assert.equal(result.done, null);
    assert.match(result.summary, /already matches|rotation|matched replacement/i);
    rmSync(ctx.profilePaths.stateDir, { recursive: true, force: true });
});
test("save() parks on state:persist when the state dir is unwritable, and recovers", async () => {
    const { Mutex } = await import("./mutex.js");
    const { TaskPool } = await import("./scheduler.js");
    const { emptyState } = await import("./state.js");
    const profile = filledProfile();
    const dir = mkdtempSync(path.join(tmpdir(), "aw-save-"));
    try {
        const blockerFile = path.join(dir, "blocker");
        writeFileSync(blockerFile, "not a directory");
        const broken = path.join(blockerFile, "profiles", "demo");
        const ctx = {
            profile,
            profileName: "demo",
            profilePaths: {
                stateDir: broken,
                stateFile: path.join(broken, "state.json"),
                statusFile: path.join(broken, "status.json"),
                historyFile: path.join(broken, "history.jsonl"),
                needsHumanFile: path.join(dir, "NEEDS-HUMAN.md"),
                pauseFile: path.join(dir, "pause"),
                stopFile: path.join(dir, "stop")
            },
            state: { ...emptyState(), profile: "demo" },
            logger: { info: () => { }, warn: () => { }, error: () => { }, debug: () => { } },
            mutex: new Mutex(),
            clients: { workers: [], managers: [] },
            pool: new TaskPool({ delivery: 1, followup: 1, review: 1, aux: 1, discovery: 1, owner: 1, agents: 4 }),
            unsupportedKinds: new Set(),
            queue: null,
            capacity: {},
            feedAgentCounts: {},
            zikiWorkflow: null,
            phase: "test",
            activity: null,
            phaseStartedAt: null,
            cycleStats: { deliveries: 0, reviews: 0, aux: 0, errors: 0 },
            runLimits: { maxRuntimeMinutes: null, maxCycles: null, stopAt: null, maxDeliveriesTotal: null },
            dryRun: false,
            configMtimeMs: null
        };
        await save(ctx);
        assert.equal(ctx.state.health.blockers["state:persist"]?.severity, "blocked");
        // Recovery: a writable dir clears the parking blocker.
        const good = path.join(dir, "good");
        ctx.profilePaths = {
            ...ctx.profilePaths,
            stateDir: good,
            stateFile: path.join(good, "state.json"),
            statusFile: path.join(good, "status.json"),
            historyFile: path.join(good, "history.jsonl")
        };
        await save(ctx);
        assert.ok(!ctx.state.health.blockers["state:persist"], "persist blocker must clear after a good save");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=orchestrator-repair.test.js.map