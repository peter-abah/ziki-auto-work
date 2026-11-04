import test from "node:test";
import assert from "node:assert/strict";
import { launchdPlistText } from "./service.js";
import { windowsKillCommand } from "./platform/process.js";

test("launchd plist carries an explicit PATH", () => {
  const plist = launchdPlistText("demo");
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /\/opt\/homebrew\/bin/);
});

test("Windows kill uses taskkill with a process tree", () => {
  const command = windowsKillCommand(1234);
  assert.equal(command.command, "taskkill");
  assert.deepEqual(command.args, ["/T", "/F", "/PID", "1234"]);
});
