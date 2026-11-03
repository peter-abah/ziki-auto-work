import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Mutex } from "./mutex.js";
import { emptyState, saveState } from "./state.js";
import type { ProfilePaths } from "./types.js";

test("Mutex serializes concurrent work", async () => {
  const mutex = new Mutex();
  const order: string[] = [];
  const first = mutex.run(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("a-end");
  });
  const second = mutex.run(async () => {
    order.push("b-start");
    order.push("b-end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("concurrent saveState calls leave a valid, complete state file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-state-"));
  const profilePaths = {
    stateDir: dir,
    stateFile: path.join(dir, "state.json")
  } as ProfilePaths;
  try {
    const first = emptyState();
    first.cycles = 1;
    const second = emptyState();
    second.cycles = 2;
    await Promise.all([saveState(profilePaths, first), saveState(profilePaths, second)]);
    const parsed = JSON.parse(await readFile(profilePaths.stateFile, "utf8")) as { cycles: number };
    assert.ok(parsed.cycles === 1 || parsed.cycles === 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
