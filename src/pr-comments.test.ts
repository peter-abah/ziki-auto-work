import test from "node:test";
import assert from "node:assert/strict";
import { actionablePrComments, isActionablePrComment } from "./pr-comments.js";
import type { PrComment } from "./github.js";

function comment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: "c1",
    author: "alice",
    body: "Please take a look",
    kind: "conversation",
    ...overrides
  };
}

const policy = { mentions: ["auto-work", "Stilgar"] };

test("ignores ordinary conversation and quoted code", () => {
  assert.equal(isActionablePrComment(comment({ body: "Here is `429: strokeWidth: 2` for context." }), policy), false);
  assert.equal(isActionablePrComment(comment({ body: "This mentions fixing and testing but is just discussion." }), policy), false);
});

test("accepts explicit mentions and commands", () => {
  assert.equal(isActionablePrComment(comment({ body: "@auto-work please rebase" }), policy), true);
  assert.equal(isActionablePrComment(comment({ body: "/fix the conflict" }), policy), true);
  assert.equal(isActionablePrComment(comment({ body: "hey @stilgar can you check" }), policy), true);
});

test("accepts inline review comments and ignores bots", () => {
  assert.equal(isActionablePrComment(comment({ kind: "review", path: "lib/a.dart", line: 4 }), policy), true);
  assert.equal(isActionablePrComment(comment({ author: "coderabbit[bot]", body: "@auto-work fix" }), policy), false);
});

test("filters comments older than the handled cutoff", () => {
  const comments = [
    comment({ id: "old", body: "@auto-work fix", createdAt: "2026-01-01T00:00:00.000Z" }),
    comment({ id: "new", body: "@auto-work fix", createdAt: "2026-01-02T00:00:00.000Z" })
  ];
  assert.deepEqual(
    actionablePrComments(comments, "2026-01-01T12:00:00.000Z", policy).map((entry) => entry.id),
    ["new"]
  );
});
