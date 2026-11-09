import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Mutex } from "./mutex.js";
import { emptyState, loadState, saveState, setTask } from "./state.js";
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

test("setTask mutations survive concurrent saves", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-task-"));
  const profilePaths = { stateDir: dir, stateFile: path.join(dir, "state.json") } as ProfilePaths;
  try {
    const state = emptyState();
    const first = saveState(profilePaths, state);
    setTask(state, { id: "issue-1", number: 1, title: "One" }, { status: "working", agentName: "bot" });
    const second = saveState(profilePaths, state);
    await Promise.all([first, second]);
    const parsed = JSON.parse(await readFile(profilePaths.stateFile, "utf8")) as {
      tasks: Record<string, { status: string; agentName?: string }>;
    };
    assert.equal(parsed.tasks["issue-1"]?.status, "working");
    assert.equal(parsed.tasks["issue-1"]?.agentName, "bot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("empty state has healthy health and old state files load a default health block", async () => {
  assert.equal(emptyState().health.state, "healthy");
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-health-"));
  const profilePaths = { stateDir: dir, stateFile: path.join(dir, "state.json") } as ProfilePaths;
  try {
    await writeFile(profilePaths.stateFile, JSON.stringify({ version: 1, cycles: 3 }), "utf8");
    const loaded = await loadState(profilePaths);
    assert.equal(loaded.cycles, 3);
    assert.equal(loaded.run.startedCycles, 0);
    assert.equal(loaded.health.state, "healthy");
    assert.deepEqual(loaded.health.blockers, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadState rejects an unknown schema version instead of merging it", async () => {
  const { loadState, pruneState } = await import("./state.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-state-"));
  const profilePaths = { stateDir: dir, stateFile: path.join(dir, "state.json") } as ProfilePaths;
  try {
    await writeFile(profilePaths.stateFile, JSON.stringify({ version: 2, cycles: 99 }));
    await assert.rejects(loadState(profilePaths), /unsupported version/);
    // Corrupt JSON still resets (loud operator action follows); versioned
    // JSON never silently merges.
    await writeFile(profilePaths.stateFile, "{not json");
    const reset = await loadState(profilePaths);
    assert.equal(reset.cycles, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pruneState caps non-open escalations per group but keeps terminal answers", async () => {
  const { pruneState } = await import("./state.js");
  const state = emptyState();
  const esc = (id: string, status: "open" | "dismissed", createdAt: string) =>
    ({
      id,
      issueId: null,
      issueNumber: null,
      issueTitle: null,
      type: "human_approval",
      body: "x",
      agentName: "a",
      createdAt,
      status,
      answer: null,
      resolvedAt: null,
      kind: "config",
      strategy: "platform:unknown_kind",
      configPatch: null,
      decision: "rejected",
      rounds: 1,
      remoteStatus: status,
      appliedAt: null,
      previousId: null
    }) as never;
  for (let i = 0; i < 6; i += 1) {
    state.escalations[`old-${i}`] = esc(`old-${i}`, "dismissed", `2026-01-0${i + 1}T00:00:00.000Z`);
  }
  state.escalations["live"] = esc("live", "open", "2026-02-01T00:00:00.000Z");
  pruneState(state);
  const remaining = Object.keys(state.escalations);
  assert.ok(remaining.includes("live"), "open escalation must survive");
  assert.ok(remaining.includes("old-5"), "latest terminal answer must survive");
  assert.equal(remaining.length, 4, `expected open + 3 latest, got ${remaining.join(",")}`);
});
