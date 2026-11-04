import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS, DEFAULT_WORKFLOW } from "./config.js";
import { emptyState, setTask } from "./state.js";
import { buildRunSummary, formatRunSummary, writeRunSummary } from "./run-report.js";
function profile() {
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
    };
}
function stateWithRun() {
    const state = emptyState();
    state.profile = "demo";
    state.cycles = 7;
    state.run = {
        startedAt: new Date(Date.now() - 90_000).toISOString(),
        limits: null,
        stopReason: "stop",
        deliveries: 2,
        reviews: 3,
        mergeReviews: 1,
        discoveries: 0,
        aux: 4,
        failures: 1,
        tokens: { input: 100, output: 50, total: 150 }
    };
    setTask(state, { id: "i1", number: 1, title: "One" }, { status: "delivered", prUrl: "https://github.com/o/n/pull/1" });
    setTask(state, { id: "i2", number: 2, title: "Two" }, { status: "failed", lastError: "missing env" });
    return state;
}
test("buildRunSummary reports counts, issues and needs-you", () => {
    const state = stateWithRun();
    state.escalations["e1"] = {
        id: "e1",
        issueId: "i2",
        issueNumber: 2,
        issueTitle: "Two",
        type: "blocker",
        body: "missing env",
        agentName: "bot",
        createdAt: new Date().toISOString(),
        status: "open",
        answer: null,
        resolvedAt: null
    };
    const summary = buildRunSummary({ state, profileName: "demo", profile: profile(), clean: true, stopReason: "stop" });
    assert.equal(summary.cycles, 7);
    assert.equal(summary.deliveries, 2);
    assert.equal(summary.failures, 1);
    assert.equal(summary.needsYou, 1);
    assert.ok(summary.issues.some((issue) => issue.number === 1 && issue.pr));
    assert.match(formatRunSummary(summary), /Ziki needs you: 1/);
});
test("unclean summary counts interrupted tasks", () => {
    const state = stateWithRun();
    setTask(state, { id: "i3", number: 3, title: "Three" }, { status: "working" });
    const summary = buildRunSummary({
        state,
        profileName: "demo",
        profile: profile(),
        clean: false,
        stopReason: "killed",
        endedAt: state.run.startedAt
    });
    assert.equal(summary.clean, false);
    assert.equal(summary.stopReason, "killed");
    assert.equal(summary.interrupted, 1);
    assert.match(formatRunSummary(summary), /did not shut down cleanly/);
});
test("writeRunSummary writes JSON and Markdown", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-summary-"));
    try {
        const state = stateWithRun();
        const summary = buildRunSummary({ state, profileName: "demo", profile: profile(), clean: true, stopReason: "stop" });
        const profilePaths = {
            stateDir: dir,
            lastRunFile: path.join(dir, "LAST-RUN.json"),
            lastRunMdFile: path.join(dir, "LAST-RUN.md")
        };
        await writeRunSummary(profilePaths, summary);
        const parsed = JSON.parse(await readFile(profilePaths.lastRunFile, "utf8"));
        assert.equal(parsed.deliveries, 2);
        assert.match(await readFile(profilePaths.lastRunMdFile, "utf8"), /Auto-work run/);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=run-report.test.js.map