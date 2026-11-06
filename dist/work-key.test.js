import test from "node:test";
import assert from "node:assert/strict";
import { deploymentEnvironment, workTargetKey } from "./work-key.js";
import { loadInitTemplates } from "./config-templates.js";
const templates = await loadInitTemplates();
const policy = templates.urls;
test("deployment environment comes from the configured suffix map", () => {
    assert.equal(deploymentEnvironment("report_deployment:issue_1:on_dev", policy), "dev");
    assert.equal(deploymentEnvironment("report_deployment:issue_1:on_staging", policy), "staging");
    assert.equal(deploymentEnvironment("report_deployment:issue_1:on_prod", policy), "prod");
    assert.equal(deploymentEnvironment("report_deployment:issue_1", policy), null);
    assert.equal(deploymentEnvironment("report_deployment:development:on_dev", policy), "dev");
});
test("suffix map is policy, not code", () => {
    const custom = { envSuffixes: { on_canary: "staging" } };
    assert.equal(deploymentEnvironment("x:on_canary", custom), "staging");
    assert.equal(deploymentEnvironment("x:on_dev", custom), null);
    assert.throws(() => deploymentEnvironment("x:on_dev", null), /urls\.envSuffixes/);
});
test("target keys scope work to the issue, idea or item", () => {
    assert.equal(workTargetKey("key", "issue_1", null), "issue:issue_1");
    assert.equal(workTargetKey("key", null, "idea_1"), "idea:idea_1");
    assert.equal(workTargetKey("key", null, null), "key:key");
});
//# sourceMappingURL=work-key.test.js.map