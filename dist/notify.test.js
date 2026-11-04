import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS, DEFAULT_WORKFLOW } from "./config.js";
import { desktopNotifier, notifyProfile, resolveNotifyMode } from "./notify.js";
function profile(overrides = {}) {
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
        hitl: { enabled: true, defaultType: "question", notify: "auto", notifyCommand: null },
        ...overrides
    };
}
test("desktopNotifier selects per platform", () => {
    assert.equal(desktopNotifier("linux")?.command, "notify-send");
    assert.equal(desktopNotifier("darwin")?.command, "osascript");
    assert.equal(desktopNotifier("win32")?.command, "powershell");
});
test("resolveNotifyMode defaults to auto", () => {
    assert.equal(resolveNotifyMode(profile()), "auto");
    assert.equal(resolveNotifyMode(profile({ hitl: { enabled: true, defaultType: "question", notify: "off" } })), "off");
});
test("off mode sends nothing", async () => {
    const result = await notifyProfile(profile({ hitl: { enabled: true, defaultType: "question", notify: "off" } }), "t", "b");
    assert.equal(result.ok, true);
});
test("command mode runs the configured command with AW_TITLE and AW_BODY", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-notify-"));
    const target = path.join(dir, "out.txt");
    const script = path.join(dir, "write-result.cjs");
    try {
        await writeFile(script, `require("fs").writeFileSync(${JSON.stringify(target)}, process.env.AW_TITLE + "|" + process.env.AW_BODY);\n`, "utf8");
        const command = `node "${script}"`;
        const result = await notifyProfile(profile({ hitl: { enabled: true, defaultType: "question", notify: "command", notifyCommand: command } }), "Title", "Body");
        assert.equal(result.ok, true, result.detail);
        assert.equal(await readFile(target, "utf8"), "Title|Body");
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=notify.test.js.map