#!/usr/bin/env node
// Prompt lint: agent prompts must not hardcode Ziki-side literals (statuses,
// API paths, project slugs). Those live in config/init-templates.json and
// flow into prompts via {{placeholders}}; a raw literal here would go stale
// on the next Ziki change without any test noticing.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const FORBIDDEN_STRINGS = [
  "requires_confirmation",
  "requires_review",
  "on_dev",
  "on_staging",
  "on_prod",
  "/api/v1/",
  "project_zedu"
];
// Single-brace endpoint-template placeholders ({org}, {project}, {issue},
// {idea}) — double-brace prompt vars like {{projectName}} are fine.
const FORBIDDEN_PATTERNS = [
  /(?<!\{)\{(org|project|issue|idea|comment|bid|offer|stake|job|submission|note|action|username|tag|id)\??\}(?!\})/
];

let failures = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
    } else if (entry.name.endsWith(".md")) {
      const text = await readFile(full, "utf8");
      for (const literal of FORBIDDEN_STRINGS) {
        if (text.includes(literal)) {
          console.error(`${path.relative(ROOT, full)}: hardcoded Ziki literal "${literal}" (use a {{placeholder}} fed from config)`);
          failures += 1;
        }
      }
      for (const pattern of FORBIDDEN_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          console.error(`${path.relative(ROOT, full)}: hardcoded endpoint placeholder "${match[0]}" (use a {{placeholder}} fed from config)`);
          failures += 1;
        }
      }
    }
  }
}

await walk(ROOT);
if (failures) {
  console.error(`prompt lint failed: ${failures} hardcoded literal(s)`);
  process.exitCode = 1;
} else {
  console.log("prompt lint: clean (no hardcoded Ziki literals in prompts/)");
}
