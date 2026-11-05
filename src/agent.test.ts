import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonResult } from "./agent.js";

test("prefers the explicit AW_RESULT_JSON marker", () => {
  const text = [
    'Example: {"ok": true, "summary": "sample"}',
    'AW_RESULT_JSON: {"ok": true, "summary": "real result", "providerLimit": null}'
  ].join("\n");
  const result = extractJsonResult(text);
  assert.equal(result?.summary, "real result");
});

test("falls back to fenced JSON for compatibility", () => {
  const text = 'Here you go:\n```json\n{"ok": true, "summary": "fenced"}\n```';
  assert.equal(extractJsonResult(text)?.summary, "fenced");
});

test("does not turn source-code JSON into a result", () => {
  const text = 'BillingInfoModel.fromJson(_billing)\n{"input":429,"output":12}';
  assert.equal(extractJsonResult(text), null);
});

test("preserves an explicit environment hint", () => {
  const result = extractJsonResult(
    'AW_RESULT_JSON: {"ok": false, "error": "flutter not found", "environmentHint": "flutter is not on PATH"}'
  );
  assert.equal(result?.environmentHint, "flutter is not on PATH");
});
