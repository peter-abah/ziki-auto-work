import test from "node:test";
import assert from "node:assert/strict";
import {
  HEARTBEAT_INTERVAL_MS,
  applyHeartbeatFailure,
  applyHeartbeatSuccess,
  heartbeatDue,
  resolveHeartbeatIntervalMs
} from "./heartbeat.js";
import type { TaskState } from "./types.js";

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
  assert.equal(heartbeatDue(task(), now), true);
  assert.equal(heartbeatDue(task({ claimId: undefined }), now), false);
  assert.equal(heartbeatDue(task({ status: "delivered" }), now), true);
  assert.equal(heartbeatDue(task({ status: "failed" }), now), false);
  assert.equal(heartbeatDue(task({ lastHeartbeatAt: new Date(now - 60_000).toISOString() }), now), false);
  assert.equal(
    heartbeatDue(task({ nextHeartbeatAt: new Date(now + HEARTBEAT_INTERVAL_MS).toISOString() }), now),
    false
  );
});

test("success schedules the next heartbeat", () => {
  const now = Date.now();
  const state = task();
  applyHeartbeatSuccess(state, now);
  assert.equal(state.lastHeartbeatAt, new Date(now).toISOString());
  assert.equal(state.nextHeartbeatAt, new Date(now + HEARTBEAT_INTERVAL_MS).toISOString());
  assert.equal(heartbeatDue(state, now + 60_000), false);
});

test("claim-lost failures clear the claim and do not retry immediately", () => {
  const now = Date.now();
  for (const status of [403, 404, 409, 410]) {
    const state = task();
    const failure = applyHeartbeatFailure(state, Object.assign(new Error("lost"), { status }), now);
    assert.equal(failure.claimLost, true);
    assert.equal(state.claimId, undefined);
    assert.equal(state.status, "queued");
    assert.equal(state.nextHeartbeatAt, undefined);
  }
  const delivered = task({ status: "delivered" });
  applyHeartbeatFailure(delivered, Object.assign(new Error("lost"), { status: 403 }), now);
  assert.equal(delivered.status, "delivered");
});

test("rate-limit and server failures back off", () => {
  const now = Date.now();
  const limited = task();
  assert.equal(applyHeartbeatFailure(limited, Object.assign(new Error("slow down"), { status: 429 }), now).retryMs, 15 * 60_000);
  const server = task();
  assert.equal(applyHeartbeatFailure(server, Object.assign(new Error("boom"), { status: 500 }), now).retryMs, 5 * 60_000);
  assert.ok(server.nextHeartbeatAt);
});

test("resolveHeartbeatIntervalMs prefers explicit config, then live workflow, then default", () => {
  // explicit config wins even over a tighter live value
  assert.equal(
    resolveHeartbeatIntervalMs({ timing: { heartbeatMs: 60_000 }, zikiWorkflow: { heartbeatMinutes: 1 } }),
    60_000
  );
  // live workflow capped at the default (never slower than default)
  assert.equal(resolveHeartbeatIntervalMs({ timing: {}, zikiWorkflow: { heartbeatMinutes: 240 } }), 10 * 60_000);
  // live workflow tighter than default wins
  assert.equal(resolveHeartbeatIntervalMs({ timing: {}, zikiWorkflow: { heartbeatMinutes: 1 } }), 60_000);
  // missing/invalid values fall back to the default
  assert.equal(resolveHeartbeatIntervalMs({ timing: {}, zikiWorkflow: {} }), 10 * 60_000);
  assert.equal(resolveHeartbeatIntervalMs({ timing: { heartbeatDefaultMs: 30_000 }, zikiWorkflow: null }), 30_000);
});
