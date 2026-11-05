import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage, isNoopZikiError, NOOP_PATTERNS } from "./noop.js";

function zikiError(status: number, message: string): Error & { status: number; body: unknown } {
  return Object.assign(new Error(message), { status, body: { message } });
}

test("reclaim no-ops are recognized", () => {
  assert.equal(isNoopZikiError(zikiError(409, "Nothing to reclaim: this work is not stale."), NOOP_PATTERNS.reclaim), true);
  assert.equal(isNoopZikiError(zikiError(409, "The offer is not stale."), NOOP_PATTERNS.reclaim), true);
  assert.equal(isNoopZikiError(zikiError(500, "Nothing to reclaim"), NOOP_PATTERNS.reclaim), false);
});

test("open no-ops are recognized", () => {
  assert.equal(isNoopZikiError(zikiError(409, "Issue is not awaiting confirmation."), NOOP_PATTERNS.open), true);
  assert.equal(isNoopZikiError(zikiError(409, "Issue is already open."), NOOP_PATTERNS.open), true);
});

test("review no-ops are recognized", () => {
  assert.equal(
    isNoopZikiError(zikiError(409, "This work already has the good-to-merge judgements it needs."), NOOP_PATTERNS.review),
    true
  );
  assert.equal(isNoopZikiError(zikiError(409, "Issue is not reviewable."), NOOP_PATTERNS.review), true);
});

test("errorMessage prefers the Ziki response body", () => {
  assert.equal(errorMessage(zikiError(409, "body message")), "body message");
  assert.equal(errorMessage(new Error("plain error")), "plain error");
});
