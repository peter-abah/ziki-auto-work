import test from "node:test";
import assert from "node:assert/strict";
import { countGoodVerdicts, reviewGate, verdictsNeeded } from "./review-gate.js";
import type { ReviewGateStatus } from "./review-gate.js";
import type { ReviewGatePolicyConfig } from "./types.js";

const policy: ReviewGatePolicyConfig = {
  transientMs: 300000,
  terminalMs: 1800000,
  openState: "OPEN",
  checkStates: { passing: "passing", failing: "failing", pending: "pending", none: "none" },
  workflowKeys: ["verdictsNeeded", "testVerdictsNeeded", "requiredTestVerdicts", "reviewsRequired"]
};

function status(overrides: Partial<ReviewGateStatus> = {}): ReviewGateStatus {
  return {
    state: "OPEN",
    merged: false,
    checks: "passing",
    mergeable: true,
    isDraft: false,
    ...overrides
  };
}

function gate(input: Omit<Parameters<typeof reviewGate>[0], "policy">): ReturnType<typeof reviewGate> {
  return reviewGate({ policy, ...input });
}

test("reviewGate allows an open, green, mergeable PR", () => {
  assert.deepEqual(gate({ status: status(), goodVerdicts: 1, verdictsNeeded: 3 }), { ok: true });
});

test("reviewGate rejects unavailable, merged, closed and draft PRs", () => {
  assert.equal(gate({ status: null }).ok, false);
  assert.equal(gate({ status: status({ merged: true }) }).ok, false);
  assert.equal(gate({ status: status({ state: "CLOSED" }) }).ok, false);
  assert.equal(gate({ status: status({ isDraft: true }) }).ok, false);
});

test("reviewGate waits for green checks and a mergeable branch", () => {
  assert.match(gate({ status: status({ checks: "failing" }) }).reason ?? "", /failing/);
  assert.match(gate({ status: status({ checks: "pending" }) }).reason ?? "", /pending/);
  assert.match(gate({ status: status({ mergeable: false }) }).reason ?? "", /conflicts/);
});

test("reviewGate skips when the issue already has enough good verdicts", () => {
  const result = gate({ status: status(), goodVerdicts: 3, verdictsNeeded: 3 });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /already has 3/);
});

test("reviewGate reads open state and check vocabulary from policy", () => {
  const custom: ReviewGatePolicyConfig = {
    ...policy,
    openState: "Abierto",
    checkStates: { passing: "ok", failing: "bad", pending: "wait", none: "none" }
  };
  assert.deepEqual(reviewGate({ status: { ...status(), state: "OPEN" }, policy: custom }).ok, false);
  assert.deepEqual(
    reviewGate({ status: { ...status(), state: "Abierto", checks: "ok" }, policy: custom }),
    { ok: true }
  );
});

test("verdictsNeeded reads the Ziki workflow setting", () => {
  assert.equal(verdictsNeeded({ verdictsNeeded: 3 }), 3);
  assert.equal(verdictsNeeded({ testVerdictsNeeded: 2 }), 2);
  assert.equal(verdictsNeeded({ reviewsRequired: "4" }), 4);
  assert.equal(verdictsNeeded({}), null);
  assert.equal(verdictsNeeded(null), null);
  assert.equal(verdictsNeeded({ customNeeded: 5 }, ["customNeeded"]), 5);
  assert.equal(verdictsNeeded({ verdictsNeeded: 3 }, ["customNeeded"]), null);
});

test("countGoodVerdicts counts distinct current agents", () => {
  assert.equal(
    countGoodVerdicts([
      { goodToMerge: true, current: true, agentId: "a" },
      { goodToMerge: true, current: true, agentId: "a" },
      { goodToMerge: true, current: true, agentId: "b" },
      { goodToMerge: false, current: true, agentId: "c" },
      { goodToMerge: true, current: false, agentId: "d" }
    ]),
    2
  );
});
