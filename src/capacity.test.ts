import test from "node:test";
import assert from "node:assert/strict";
import { resolveCapacity, underCap } from "./capacity.js";
import { DEFAULT_LIMITS } from "./config.js";
import type { ProfileConfig } from "./types.js";

function profile(limits: Partial<ProfileConfig["limits"]> = {}): ProfileConfig {
  return {
    limits: { ...DEFAULT_LIMITS, ...limits },
    capacity: { floor: 1, discoverySlots: 1, ownerSlots: 1 }
  } as ProfileConfig;
}

test("auto capacity follows the number of agents", () => {
  const capacity = resolveCapacity(profile(), { workers: [1], managers: [2, 3] });
  assert.equal(capacity.workers, 1);
  assert.equal(capacity.totalKeys, 3);
  assert.equal(capacity.agentCeiling, 3);
  assert.equal(capacity.delivery, 1);
  assert.equal(capacity.review, 1);
  assert.equal(capacity.aux, 3);
  assert.equal(capacity.followup, 1);
  assert.equal(capacity.activeClaims, 1);
  assert.equal(capacity.discovery, 1);
  assert.equal(capacity.owner, 1);
});

test("a four-worker profile gets four deliveries and reviews by default", () => {
  const capacity = resolveCapacity(profile(), { workers: [1, 2, 3, 4], managers: [] });
  assert.equal(capacity.agentCeiling, 4);
  assert.equal(capacity.delivery, 4);
  assert.equal(capacity.review, 4);
  assert.equal(capacity.aux, 4);
  assert.equal(capacity.followup, 4);
  assert.equal(capacity.activeClaims, 4);
});

test("explicit limits override auto values", () => {
  const capacity = resolveCapacity(
    profile({
      maxConcurrentReviews: 2,
      maxConcurrentDeliveries: 1,
      maxConcurrentAux: 5,
      maxConcurrentAgents: 2
    }),
    { workers: [1, 2, 3, 4], managers: [5] }
  );
  assert.equal(capacity.agentCeiling, 2);
  assert.equal(capacity.review, 2);
  assert.equal(capacity.delivery, 1);
  assert.equal(capacity.aux, 5);
});

test("null work caps are unbounded but numeric caps bind", () => {
  assert.equal(underCap(100, null), true);
  assert.equal(underCap(100, "auto"), true);
  assert.equal(underCap(3, 3), false);
  assert.equal(underCap(2, 3), true);
});

test("capacity slots and floor come from policy", () => {
  const custom = {
    limits: { ...DEFAULT_LIMITS, maxConcurrentDiscovery: "auto" as const },
    capacity: { floor: 2, discoverySlots: 3, ownerSlots: 4 }
  } as ProfileConfig;
  const capacity = resolveCapacity(custom, { workers: [1], managers: [] });
  assert.equal(capacity.discovery, 3);
  assert.equal(capacity.owner, 4);
  assert.equal(capacity.delivery, 1);
  assert.throws(
    () => resolveCapacity({ limits: { ...DEFAULT_LIMITS } } as ProfileConfig, { workers: [1], managers: [] }),
    /capacity\.floor/
  );
});
