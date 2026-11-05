import test from "node:test";
import assert from "node:assert/strict";
import { deploymentEnvironment, workTargetKey } from "./work-key.js";
test("deployment environment comes from the exact key suffix", () => {
    assert.equal(deploymentEnvironment("report_deployment:issue_1:on_dev"), "dev");
    assert.equal(deploymentEnvironment("report_deployment:issue_1:on_staging"), "staging");
    assert.equal(deploymentEnvironment("report_deployment:issue_1:on_prod"), "prod");
    assert.equal(deploymentEnvironment("report_deployment:issue_1"), null);
    assert.equal(deploymentEnvironment("report_deployment:development:on_dev"), "dev");
});
test("target keys scope work to the issue, idea or item", () => {
    assert.equal(workTargetKey("key", "issue_1", null), "issue:issue_1");
    assert.equal(workTargetKey("key", null, "idea_1"), "idea:idea_1");
    assert.equal(workTargetKey("key", null, null), "key:key");
});
//# sourceMappingURL=work-key.test.js.map