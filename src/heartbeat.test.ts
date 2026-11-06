import test from "node:test";
import assert from "node:assert/strict";
import {
  applyHeartbeatFailure,
  applyHeartbeatSuccess,
  heartbeatDue,
  resolveHeartbeatIntervalMs
} from "./heartbeat.js";
import type { HeartbeatPolicyConfig, TaskState } from "./types.js";

const policy: HeartbeatPolicyConfig = {
  intervalMs: 600000,
  eligibleStates: ["queued", "claimed", "working", "waiting_human", "delivered"],
  lostStatuses: [403, 404, 409, 410],
  rateLimitMs: 900000,
  genericMs: 300000,
  workflowKey: "heartbeatMinutes"
};

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "issue_1",
    number: 1,
    title: "One",
    status: "working",
    attempts: 1,
    agentName: "ZIKI_KEY2",
    claimId: "claim_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

test("heartbeatDue requires a claim and respects the interval", () => {
  const now = Date.now();
  assert.equal(heartbeatDue(task(), now, policy.intervalMs!, policy), true);
  assert.equal(heartbeatDue(task({ claimId: undefined }), now, policy.intervalMs!, policy), false);
  assert.equal(heartbeatDue(task({ status: "delivered" }), now, policy.intervalMs!, policy), true);
  assert.equal(heartbeatDue(task({ status: "failed" }), now, policy.intervalMs!, policy), false);
  assert.equal(
    heartbeatDue(task({ lastHeartbeatAt: new Date(now - 60_000).toISOString() }), now, policy.intervalMs!, policy),
    false
  );
  assert.equal(
    heartbeatDue(task({ nextHeartbeatAt: new Date(now + policy.intervalMs!).toISOString() }), now, policy.intervalMs!, policy),
    false
  );
});

test("success schedules the next heartbeat", () => {
  const now = Date.now();
  const state = task();
  applyHeartbeatSuccess(state, now, policy.intervalMs!);
  assert.equal(state.lastHeartbeatAt, new Date(now).toISOString());
  assert.equal(state.nextHeartbeatAt, new Date(now + policy.intervalMs!).toISOString());
  assert.equal(heartbeatDue(state, now + 60_000, policy.intervalMs!, policy), false);
});

test("claim-lost failures clear the claim and do not retry immediately", () => {
  const now = Date.now();
  for (const status of [403, 404, 409, 410]) {
    const state = task();
    const failure = applyHeartbeatFailure(state, Object.assign(new Error("lost"), { status }), now, policy);
    assert.equal(failure.claimLost, true);
    assert.equal(state.claimId, undefined);
    assert.equal(state.status, "queued");
    assert.equal(state.nextHeartbeatAt, undefined);
  }
  const delivered = task({ status: "delivered" });
  applyHeartbeatFailure(delivered, Object.assign(new Error("lost"), { status: 403 }), now, policy);
  assert.equal(delivered.status, "delivered");
});

test("rate-limit and server failures back off per policy", () => {
  const now = Date.now();
  const limited = task();
  assert.equal(applyHeartbeatFailure(limited, Object.assign(new Error("slow down"), { status: 429 }), now, policy).retryMs, 900000);
  const server = task();
  assert.equal(applyHeartbeatFailure(server, Object.assign(new Error("boom"), { status: 500 }), now, policy).retryMs, 300000);
  assert.ok(server.nextHeartbeatAt);
});

test("lost statuses are policy, not code", () => {
  const now = Date.now();
  const custom = { ...policy, lostStatuses: [404] };
  assert.equal(applyHeartbeatFailure(task(), Object.assign(new Error("x"), { status: 404 }), now, custom).claimLost, true);
  assert.equal(applyHeartbeatFailure(task(), Object.assign(new Error("x"), { status: 403 }), now, custom).claimLost, false);
});

test("resolveHeartbeatIntervalMs prefers explicit config, then live workflow, then policy", () => {
  // explicit config wins even over a tighter live value
  assert.equal(
    resolveHeartbeatIntervalMs({ timing: { heartbeatMs: 60_000 }, policy, zikiWorkflow: { heartbeatMinutes: 1 } }),
    60_000
  );
  // live workflow capped at the policy default (never slower than default)
  assert.equal(resolveHeartbeatIntervalMs({ timing: {}, policy, zikiWorkflow: { heartbeatMinutes: 240 } }), 600000);
  // live workflow tighter than default wins
  assert.equal(resolveHeartbeatIntervalMs({ timing: {}, policy, zikiWorkflow: { heartbeatMinutes: 1 } }), 60_000);
  // missing/invalid values fall back to the policy default
  assert.equal(resolveHeartbeatIntervalMs({ timing: {}, policy, zikiWorkflow: {} }), 600000);
  assert.equal(resolveHeartbeatIntervalMs({ timing: { heartbeatDefaultMs: 30_000 }, policy, zikiWorkflow: null }), 30_000);
  // missing policy default fails loud
  assert.throws(() => resolveHeartbeatIntervalMs({ timing: {}, policy: {}, zikiWorkflow: {} }), /heartbeatPolicy.intervalMs/);
});
