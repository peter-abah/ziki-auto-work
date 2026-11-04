import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderLimit } from "./provider-errors.js";

test("classifies hard quota and billing errors", () => {
  assert.equal(classifyProviderLimit("insufficient_quota"), "quota");
  assert.equal(classifyProviderLimit("You exceeded your current quota"), "quota");
  assert.equal(classifyProviderLimit("credit balance is too low"), "quota");
});

test("classifies rate limits and context overflow", () => {
  assert.equal(classifyProviderLimit("429 Too Many Requests"), "rate-limit");
  assert.equal(classifyProviderLimit("provider overloaded"), "rate-limit");
  assert.equal(classifyProviderLimit("maximum context length exceeded"), "context");
});

test("returns null for ordinary failures", () => {
  assert.equal(classifyProviderLimit("tests failed"), null);
});
