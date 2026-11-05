import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeIdeaSummary } from "./idea-input.js";

test("summaries become plain, short and valid", () => {
  const text = sanitizeIdeaSummary("# Bad `markdown`\n**line two**\n> line three\nline four", "fallback");
  assert.equal(/[#*`>|]/.test(text), false);
  assert.equal(text.includes("\n"), false);
  assert.ok(text.length >= 20 && text.length <= 300);
});

test("short and empty summaries get a usable fallback", () => {
  assert.ok(sanitizeIdeaSummary("tiny").length >= 20);
  assert.ok(sanitizeIdeaSummary("", "Desktop parity gap").length >= 20);
});
