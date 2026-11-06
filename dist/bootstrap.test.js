import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapOnConfigFailure, buildEscalationBody, buildNeedsHumanBody } from "./bootstrap.js";
function withTempHome() {
    const dir = mkdtempSync(path.join(tmpdir(), "aw-bootstrap-"));
    const previous = {};
    for (const key of ["AUTO_WORK_CONFIG_DIR", "AUTO_WORK_STATE_DIR", "AUTO_WORK_HOME"]) {
        previous[key] = process.env[key];
        delete process.env[key];
    }
    process.env.AUTO_WORK_CONFIG_DIR = path.join(dir, "config");
    process.env.AUTO_WORK_STATE_DIR = path.join(dir, "state");
    return {
        dir,
        restore: () => {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
    };
}
test("escalation and NEEDS-HUMAN bodies explain the failure without leaking internals", () => {
    const body = buildEscalationBody(new Error("boom").message, "demo");
    assert.match(body, /could not start/);
    assert.match(body, /boom/);
    assert.ok(!body.includes("ZIKI_KEY"));
    const needs = buildNeedsHumanBody({
        reason: "bad config",
        profileName: "demo",
        keyEnvName: null,
        escalationId: null,
        escalationAnswer: null
    });
    assert.match(needs, /auto-work init/);
    assert.match(needs, /No usable Ziki key/);
});
test("bootstrap without keys writes NEEDS-HUMAN and asks for a key", async () => {
    const { restore } = withTempHome();
    try {
        const result = await bootstrapOnConfigFailure({ profileName: "demo", reason: new Error("nope") });
        assert.equal(result.escalated, false);
        assert.equal(result.escalationId, null);
        const needs = readFileSync(result.needsHumanFile, "utf8");
        assert.match(needs, /NEEDS-HUMAN|needs you|Next steps/);
        assert.match(needs, /keys import/);
        const state = JSON.parse(readFileSync(result.needsHumanFile.replace(/NEEDS-HUMAN\.md$/, "BOOTSTRAP.json"), "utf8"));
        assert.equal(state.keyEnvName, null);
        assert.equal(state.reason, "nope");
    }
    finally {
        restore();
    }
});
//# sourceMappingURL=bootstrap.test.js.map