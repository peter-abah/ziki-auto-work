import test from "node:test";
import assert from "node:assert/strict";
import { mergeGateReason } from "./merge.js";
const base = {
    zikiReady: true,
    checks: "passing",
    mergeable: true,
    merged: false,
    state: "OPEN",
    reviewDecision: "APPROVED",
    approvedReviews: 1
};
test("auto merge passes only when every gate is green", () => {
    assert.equal(mergeGateReason(base), null);
});
test("auto merge refuses handoff-only and blocked states", () => {
    assert.match(mergeGateReason({ ...base, zikiReady: false }), /accepted/);
    assert.match(mergeGateReason({ ...base, merged: true }), /already merged/);
    assert.match(mergeGateReason({ ...base, state: "CLOSED" }), /closed/);
    assert.match(mergeGateReason({ ...base, checks: "failing" }), /checks/);
    assert.match(mergeGateReason({ ...base, checks: "pending" }), /checks/);
    assert.match(mergeGateReason({ ...base, mergeable: false }), /conflict/);
    assert.match(mergeGateReason({ ...base, reviewDecision: "CHANGES_REQUESTED" }), /changes/);
    assert.match(mergeGateReason({ ...base, reviewDecision: null, approvedReviews: 0 }), /approvals/);
});
test("required reviewer count must be met", () => {
    assert.match(mergeGateReason({ ...base, approvedReviews: 1, requiredReviewers: 2 }), /approvals/);
    assert.equal(mergeGateReason({ ...base, approvedReviews: 2, requiredReviewers: 2 }), null);
});
//# sourceMappingURL=merge.test.js.map