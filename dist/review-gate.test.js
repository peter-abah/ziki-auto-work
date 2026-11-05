import test from "node:test";
import assert from "node:assert/strict";
import { countGoodVerdicts, reviewGate, verdictsNeeded } from "./review-gate.js";
function status(overrides = {}) {
    return {
        state: "OPEN",
        merged: false,
        checks: "passing",
        mergeable: true,
        isDraft: false,
        ...overrides
    };
}
test("reviewGate allows an open, green, mergeable PR", () => {
    assert.deepEqual(reviewGate({ status: status(), goodVerdicts: 1, verdictsNeeded: 3 }), { ok: true });
});
test("reviewGate rejects unavailable, merged, closed and draft PRs", () => {
    assert.equal(reviewGate({ status: null }).ok, false);
    assert.equal(reviewGate({ status: status({ merged: true }) }).ok, false);
    assert.equal(reviewGate({ status: status({ state: "CLOSED" }) }).ok, false);
    assert.equal(reviewGate({ status: status({ isDraft: true }) }).ok, false);
});
test("reviewGate waits for green checks and a mergeable branch", () => {
    assert.match(reviewGate({ status: status({ checks: "failing" }) }).reason ?? "", /failing/);
    assert.match(reviewGate({ status: status({ checks: "pending" }) }).reason ?? "", /pending/);
    assert.match(reviewGate({ status: status({ mergeable: false }) }).reason ?? "", /conflicts/);
});
test("reviewGate skips when the issue already has enough good verdicts", () => {
    const result = reviewGate({ status: status(), goodVerdicts: 3, verdictsNeeded: 3 });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /already has 3/);
});
test("verdictsNeeded reads the Ziki workflow setting", () => {
    assert.equal(verdictsNeeded({ verdictsNeeded: 3 }), 3);
    assert.equal(verdictsNeeded({ testVerdictsNeeded: 2 }), 2);
    assert.equal(verdictsNeeded({ reviewsRequired: "4" }), 4);
    assert.equal(verdictsNeeded({}), null);
    assert.equal(verdictsNeeded(null), null);
});
test("countGoodVerdicts counts distinct current agents", () => {
    assert.equal(countGoodVerdicts([
        { goodToMerge: true, current: true, agentId: "a" },
        { goodToMerge: true, current: true, agentId: "a" },
        { goodToMerge: true, current: true, agentId: "b" },
        { goodToMerge: false, current: true, agentId: "c" },
        { goodToMerge: true, current: false, agentId: "d" }
    ]), 2);
});
//# sourceMappingURL=review-gate.test.js.map