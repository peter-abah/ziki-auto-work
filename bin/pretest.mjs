import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("tsconfig.json")) {
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], { stdio: "inherit" });
process.exit(result.status ?? 1);
