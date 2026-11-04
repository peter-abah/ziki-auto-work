#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function skip(reason) {
  if (process.env.AUTO_WORK_DEBUG_INSTALL) console.log(`auto-work postinstall: skipped (${reason})`);
  process.exit(0);
}

if (process.env.AUTO_WORK_NO_SHIM === "1") skip("AUTO_WORK_NO_SHIM=1");
if (process.env.CI) skip("CI");
if (typeof process.getuid === "function" && process.getuid() === 0) skip("root user");
if (process.env.npm_config_global !== "true") skip("not a global install");

let result;
try {
  const { installShim } = await import("../dist/shim.js");
  result = await installShim({ packageRoot, home: os.homedir() });
} catch (error) {
  console.error(`auto-work postinstall: could not create shim: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
}

if (!result) {
  console.error("auto-work: could not determine a user bin directory; run `npx ziki-auto-work install` or add the npm global bin directory to PATH.");
  process.exit(0);
}
if (result.created) {
  console.log(`auto-work: installed command shim at ${result.plan.path}`);
  if (!result.plan.onPath) {
    console.error(`auto-work: ${result.plan.dir} is not on PATH; add it or open a new terminal after doing so.`);
  }
}
