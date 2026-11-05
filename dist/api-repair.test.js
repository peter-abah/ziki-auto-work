import test from "node:test";
import assert from "node:assert/strict";
import { contractKey, recordRejected, repairApiBody, stripRejectedFields } from "./api-repair.js";
test("contract keys group ids and numbers", () => {
    assert.equal(contractKey("post", "/api/v1/ideas"), "POST /api/v1/ideas");
    assert.equal(contractKey("post", "/api/v1/issues/123/confirmations"), "POST /api/v1/issues/:n/confirmations");
    assert.equal(contractKey("get", "/api/v1/issues/cmw3abc1234567890"), "GET /api/v1/issues/:id");
});
test("unknown fields are removed and recorded", () => {
    const body = { title: "x", platform: "desktop", nested: { ok: true } };
    const error = {
        details: [{ code: "unrecognized_keys", keys: ["platform"], path: [] }]
    };
    const repaired = repairApiBody(body, error);
    assert.deepEqual(repaired?.body, { title: "x", nested: { ok: true } });
    assert.deepEqual(repaired?.rejected, ["platform"]);
    const contracts = {};
    recordRejected(contracts, "POST /api/v1/ideas", repaired.rejected);
    assert.deepEqual(contracts["POST /api/v1/ideas"]?.rejected, ["platform"]);
    assert.deepEqual(stripRejectedFields({ title: "y", platform: "desktop" }, ["platform"]), { title: "y" });
});
test("overlong strings are truncated when the API reports a maximum", () => {
    const repaired = repairApiBody({ summary: "1234567890" }, { details: [{ code: "too_big", path: ["summary"], maximum: 5 }] });
    assert.deepEqual(repaired?.body, { summary: "12345" });
});
test("a top-level field error is removed as a fallback", () => {
    const repaired = repairApiBody({ title: "x", platform: "desktop" }, { field: "platform" });
    assert.deepEqual(repaired?.body, { title: "x" });
});
//# sourceMappingURL=api-repair.test.js.map