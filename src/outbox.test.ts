import test from "node:test";
import assert from "node:assert/strict";
import type { State } from "./types.js";
import { flushOutbox, outboxDepth, queueOutbox } from "./outbox.js";

function fixtureState(): State {
  return { escalations: {} } as unknown as State;
}

const ideas = [{ id: "a", number: 1, title: "Alpha", status: "open" }];

test("queues and flushes ideas FIFO, skipping known titles", async () => {
  const state = fixtureState();
  queueOutbox(state, { kind: "createIdea", body: { title: "Alpha" }, title: "Alpha" });
  queueOutbox(state, { kind: "createIdea", body: { title: "Beta" }, title: "Beta" });
  assert.equal(outboxDepth(state), 2);

  const created: string[] = [];
  const client = {
    createIdea: async (body: { title: string }) => {
      created.push(body.title);
      return { idea: { number: 9 } };
    }
  } as never;
  const events: string[] = [];
  const result = await flushOutbox(state, client, {
    knownIdeaTitles: new Set(["Alpha"]),
    onEvent: (event) => events.push(event.type)
  });
  assert.deepEqual(created, ["Beta"]);
  assert.deepEqual(events, ["skipped-duplicate", "flushed"]);
  assert.equal(result.flushed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(outboxDepth(state), 0);
});

test("a failing flush stops the queue and retries next cycle, then drops after max attempts", async () => {
  const state = fixtureState();
  queueOutbox(state, { kind: "createIdea", body: { title: "Gamma" }, title: "Gamma" });
  const failing = {
    createIdea: async () => {
      throw new Error("Project not found");
    }
  } as never;
  const first = await flushOutbox(state, failing, { knownIdeaTitles: new Set() });
  assert.equal(first.flushed, 0);
  assert.equal(first.pending, 1);
  assert.equal(first.deferred, "Project not found");
  assert.equal(outboxDepth(state), 1);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await flushOutbox(state, failing, { knownIdeaTitles: new Set() });
  }
  assert.equal(outboxDepth(state), 0);
  assert.equal(state.outbox!.failed.length, 1);
  assert.equal(state.outbox!.failed[0]!.attempts >= 25, true);
});

test("report entries call through with their stored payload", async () => {
  const state = fixtureState();
  queueOutbox(state, {
    kind: "reportPrStatus",
    issueId: "issue-1",
    issueNumber: 42,
    body: { state: "merged" }
  });
  const calls: unknown[] = [];
  const client = {
    createIssue: async () => {
      throw new Error("should not be called");
    },
    reportPrStatus: async (id: string, report: unknown) => {
      calls.push([id, report]);
      return { ok: true };
    }
  } as never;
  const result = await flushOutbox(state, client, { knownIdeaTitles: new Set(ideas.map((idea) => idea.title)) });
  assert.equal(result.flushed, 1);
  assert.deepEqual(calls, [["issue-1", { state: "merged" }]]);
});
