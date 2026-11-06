import test from "node:test";
import assert from "node:assert/strict";
import { ideaPolicyLimits, sanitizeIdeaSummary } from "./idea-input.js";
import { loadInitTemplates } from "./config-templates.js";

const templates = await loadInitTemplates();
const policy = templates.idea as { summaryMin: number; suffix: string; summaryMax: number; titleMax: number; descriptionMax: number; fallback: string };

test("summaries become plain, short and valid", () => {
  const text = sanitizeIdeaSummary("# Bad `markdown`\n**line two**\n> line three\nline four", "fallback", policy);
  assert.equal(/[#*`>|]/.test(text), false);
  assert.equal(text.includes("\n"), false);
  assert.ok(text.length >= 20 && text.length <= 300);
});

test("short and empty summaries get a usable fallback", () => {
  assert.ok(sanitizeIdeaSummary("tiny", "", policy).length >= 20);
  assert.ok(sanitizeIdeaSummary("", "Desktop parity gap", policy).length >= 20);
});

test("limits come from policy, not code", () => {
  assert.deepEqual(ideaPolicyLimits(policy), { titleMax: 200, descriptionMax: 5000 });
  const custom = { ...policy, summaryMax: 50, titleMax: 10 };
  assert.ok(sanitizeIdeaSummary("x".repeat(100), "", custom).length <= 50);
  assert.deepEqual(ideaPolicyLimits(custom), { titleMax: 10, descriptionMax: 5000 });
  assert.throws(() => sanitizeIdeaSummary("x", "", null), /idea policy is required/);
});
