import test from "node:test";
import assert from "node:assert/strict";
import { rotatedKinds } from "./fair-queue.js";

test("rotatedKinds cycles past the last dispatched kind", () => {
  const entries = [{ kind: "investigate" }, { kind: "comment" }, { kind: "bid" }];
  assert.deepEqual(rotatedKinds(entries, null), ["investigate", "comment", "bid"]);
  assert.deepEqual(rotatedKinds(entries, "investigate"), ["comment", "bid", "investigate"]);
  assert.deepEqual(rotatedKinds(entries, "bid"), ["investigate", "comment", "bid"]);
});

test("rotatedKinds starts at the first kind when the last one is gone", () => {
  const entries = [{ kind: "investigate" }, { kind: "comment" }];
  assert.deepEqual(rotatedKinds(entries, "award"), ["investigate", "comment"]);
  assert.deepEqual(rotatedKinds([], "comment"), []);
});
