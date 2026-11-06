import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonResult } from "./agent.js";
test("prefers the explicit AW_RESULT_JSON marker", () => {
    const text = [
        'Example: {"ok": true, "summary": "sample"}',
        'AW_RESULT_JSON: {"ok": true, "summary": "real result", "providerLimit": null}'
    ].join("\n");
    const result = extractJsonResult(text);
    assert.equal(result?.summary, "real result");
});
test("falls back to fenced JSON for compatibility", () => {
    const text = 'Here you go:\n```json\n{"ok": true, "summary": "fenced"}\n```';
    assert.equal(extractJsonResult(text)?.summary, "fenced");
});
test("does not turn source-code JSON into a result", () => {
    const text = 'BillingInfoModel.fromJson(_billing)\n{"input":429,"output":12}';
    assert.equal(extractJsonResult(text), null);
});
test("preserves an explicit environment hint", () => {
    const result = extractJsonResult('AW_RESULT_JSON: {"ok": false, "error": "flutter not found", "environmentHint": "flutter is not on PATH"}');
    assert.equal(result?.environmentHint, "flutter is not on PATH");
});
test("recovers a printed result when the agent never writes the file", async () => {
    const { runAgent } = await import("./agent.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const dir = mkdtempSync(path.join(tmpdir(), "aw-agent-"));
    const answer = {
        ok: true,
        summary: "recovered",
        configPatch: [{ path: "ziki.projectId", value: "c1", reason: "test" }]
    };
    const profile = {
        ziki: {
            baseUrl: "https://ziki.dev",
            projectId: "project_test",
            projectSlug: "test",
            platform: "desktop"
        },
        executor: {
            provider: "custom",
            command: process.execPath,
            args: ["-e", `console.log(${JSON.stringify(JSON.stringify(answer))})`]
        }
    };
    const profilePaths = {
        resultsDir: path.join(dir, "results"),
        logsDir: path.join(dir, "logs")
    };
    const resultPath = path.join(dir, "results", "configDoctor-test.json");
    const result = await runAgent({
        profile,
        profilePaths,
        role: "configDoctor",
        prompt: "print the answer",
        cwd: dir,
        resultPath,
        logPath: path.join(dir, "logs", "agents.log")
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.configPatch, answer.configPatch);
});
//# sourceMappingURL=agent.test.js.map