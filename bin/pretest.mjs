import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

if (!existsSync("tsconfig.json")) {
  process.exit(0);
}

const require = createRequire(import.meta.url);
let tsc;
try {
  tsc = require.resolve("typescript/bin/tsc");
} catch {
  process.exit(0);
}

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { stdio: "inherit" });
process.exit(result.status ?? 1);
