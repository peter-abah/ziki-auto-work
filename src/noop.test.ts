import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage, isNoopZikiError, noopPatterns, resolvePatterns } from "./noop.js";
import { loadInitTemplates } from "./config-templates.js";

const templates = await loadInitTemplates();
const policy = templates.noop as { statuses: number[]; patterns: Record<string, string[]> };

function zikiError(status: number, message: string): Error & { status: number; body: unknown } {
  return Object.assign(new Error(message), { status, body: { message } });
}

test("template noop policy resolves to compiled patterns", () => {
  const resolved = resolvePatterns(policy);
  assert.ok(resolved.reclaim!.length >= 2);
  assert.ok(resolved.open!.length >= 3);
});

test("reclaim no-ops are recognized", () => {
  const patterns = noopPatterns(policy, "reclaim");
  assert.equal(isNoopZikiError(zikiError(409, "Nothing to reclaim: this work is not stale."), patterns, policy), true);
  assert.equal(isNoopZikiError(zikiError(409, "The offer is not stale."), patterns, policy), true);
  assert.equal(isNoopZikiError(zikiError(500, "Nothing to reclaim"), patterns, policy), false);
});

test("open no-ops are recognized", () => {
  const patterns = noopPatterns(policy, "open");
  assert.equal(isNoopZikiError(zikiError(409, "Issue is not awaiting confirmation."), patterns, policy), true);
  assert.equal(isNoopZikiError(zikiError(409, "Issue is already open."), patterns, policy), true);
});

test("review no-ops are recognized", () => {
  const patterns = noopPatterns(policy, "review");
  assert.equal(
    isNoopZikiError(zikiError(409, "This work already has the good-to-merge judgements it needs."), patterns, policy),
    true
  );
  assert.equal(isNoopZikiError(zikiError(409, "Issue is not reviewable."), patterns, policy), true);
});

test("statuses and patterns are policy, not code", () => {
  const custom = { statuses: [409], patterns: { reclaim: ["custom marker"] } };
  assert.equal(
    isNoopZikiError(zikiError(409, "custom marker here"), noopPatterns(custom, "reclaim"), custom),
    true
  );
  assert.equal(
    isNoopZikiError(zikiError(422, "custom marker here"), noopPatterns(custom, "reclaim"), custom),
    false
  );
  assert.deepEqual(noopPatterns(custom, "missing"), []);
});

test("errorMessage prefers the Ziki response body", () => {
  assert.equal(errorMessage(zikiError(409, "body message")), "body message");
  assert.equal(errorMessage(new Error("plain error")), "plain error");
});
