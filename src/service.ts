import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { profilePaths, paths, safeName } from "./platform/paths.js";
import { runCommand, spawnDetached } from "./platform/spawn.js";
import { killProcessTree } from "./platform/process.js";
import {
  clearPid,
  isAlive,
  isPaused,
  isStopped,
  readPid,
  setPaused,
  setStopped
} from "./state.js";

function binPath(): string {
  return path.join(paths().packageRoot, "bin/auto-work.mjs");
}

function unitName(profileName: string): string {
  return `auto-work-${safeName(profileName)}`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function servicePath(): string {
  const standard = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const current = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...current, ...standard])].join(path.delimiter);
}

export function systemdUnitText(profileName: string): string {
  return `[Unit]
Description=auto-work (${profileName})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${paths().home}
ExecStart=${process.execPath} ${binPath()} start --foreground --profile ${profileName}
Restart=on-failure
RestartSec=15
KillMode=control-group
TimeoutStopSec=60
Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}

[Install]
WantedBy=default.target
`;
}

export function launchdPlistText(profileName: string): string {
  const jp = profilePaths(profileName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.autowork.${safeName(profileName)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binPath()}</string>
    <string>start</string>
    <string>--foreground</string>
    <string>--profile</string>
    <string>${profileName}</string>
  </array>
  <key>WorkingDirectory</key><string>${paths().home}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(servicePath())}</string>
    <key>HOME</key><string>${xmlEscape(paths().home)}</string>
    ${process.env.LANG ? `<key>LANG</key><string>${xmlEscape(process.env.LANG)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${path.join(jp.logsDir, "service.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(jp.logsDir, "service.error.log")}</string>
</dict>
</plist>
`;
}

function windowsCmdText(profileName: string): string {
  return `@echo off\r\n"${process.execPath}" "${binPath()}" start --foreground --profile ${profileName}\r\n`;
}

export async function installService(profileName: string): Promise<{ ok: boolean; mode: string; file: string; detail?: string }> {
  const p = paths();
  if (process.platform === "linux") {
    await mkdir(p.systemdDir, { recursive: true });
    const file = path.join(p.systemdDir, `${unitName(profileName)}.service`);
    await writeFile(file, systemdUnitText(profileName), "utf8");
    const reload = await runCommand("systemctl", ["--user", "daemon-reload"]);
    const enable = await runCommand("systemctl", ["--user", "enable", `${unitName(profileName)}.service`]);
    return { ok: reload.ok && enable.ok, mode: "systemd", file, detail: enable.stderr || reload.stderr };
  }
  if (process.platform === "darwin") {
    await mkdir(p.launchdDir, { recursive: true });
    await mkdir(profilePaths(profileName).logsDir, { recursive: true });
    const file = path.join(p.launchdDir, `io.autowork.${safeName(profileName)}.plist`);
    await writeFile(file, launchdPlistText(profileName), "utf8");
    const load = await runCommand("launchctl", ["load", "-w", file]);
    return { ok: load.ok, mode: "launchd", file, detail: load.stderr };
  }
  if (process.platform === "win32") {
    const dir = path.dirname(p.bin);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${unitName(profileName)}.cmd`);
    await writeFile(file, windowsCmdText(profileName), "utf8");
    const task = await runCommand("schtasks", [
      "/Create",
      "/SC",
      "ONLOGON",
      "/TN",
      unitName(profileName),
      "/TR",
      file,
      "/F"
    ]);
    return { ok: task.ok, mode: "task-scheduler", file, detail: task.stderr };
  }
  return { ok: false, mode: "unsupported", file: "", detail: `unsupported platform ${process.platform}` };
}

export async function startService(profileName: string): Promise<{ mode: string; pid?: number }> {
  const jp = profilePaths(profileName);
  const existing = await readPid(jp);
  if (existing) return { mode: "already-running", pid: existing };
  await unlink(jp.stopFile).catch(() => {});

  if (process.platform === "linux") {
    const unit = `${unitName(profileName)}.service`;
    const unitFile = path.join(paths().systemdDir, unit);
    if (existsSync(unitFile)) {
      const result = await runCommand("systemctl", ["--user", "start", unit]);
      if (result.ok) return { mode: "systemd" };
    }
  }
  if (process.platform === "darwin") {
    const plist = path.join(paths().launchdDir, `io.autowork.${safeName(profileName)}.plist`);
    if (existsSync(plist)) {
      const result = await runCommand("launchctl", ["load", "-w", plist]);
      if (result.ok) return { mode: "launchd" };
    }
  }
  if (process.platform === "win32") {
    const result = await runCommand("schtasks", ["/Run", "/TN", unitName(profileName)]);
    if (result.ok) return { mode: "task-scheduler" };
  }

  const child = spawnDetached(process.execPath, [binPath(), "start", "--foreground", "--profile", profileName], {
    cwd: paths().home
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { mode: "detached", pid: child.pid };
}

export async function stopService(profileName: string): Promise<{ stopped: boolean; pid: number | null }> {
  const jp = profilePaths(profileName);
  await setStopped(jp, true);

  if (process.platform === "linux") {
    await runCommand("systemctl", ["--user", "stop", `${unitName(profileName)}.service`]);
  } else if (process.platform === "darwin") {
    const plist = path.join(paths().launchdDir, `io.autowork.${safeName(profileName)}.plist`);
    await runCommand("launchctl", ["unload", "-w", plist]);
  } else if (process.platform === "win32") {
    await runCommand("schtasks", ["/End", "/TN", unitName(profileName)]);
  }

  const pid = await readPid(jp);
  if (pid) {
    killProcessTree(pid);
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!isAlive(pid)) break;
    }
  }
  await clearPid(jp);
  await unlink(jp.stopFile).catch(() => {});
  return { stopped: true, pid };
}

export async function statusService(profileName: string): Promise<{
  pid: number | null;
  running: boolean;
  paused: boolean;
  stopped: boolean;
  status: Record<string, unknown> | null;
  profilePaths: ReturnType<typeof profilePaths>;
}> {
  const jp = profilePaths(profileName);
  const pid = await readPid(jp);
  const paused = await isPaused(jp);
  const stopped = await isStopped(jp);
  let status: Record<string, unknown> | null = null;
  if (existsSync(jp.statusFile)) {
    try {
      status = JSON.parse(await readFile(jp.statusFile, "utf8")) as Record<string, unknown>;
    } catch {
      status = null;
    }
  }
  return { pid, running: Boolean(pid), paused, stopped, status, profilePaths: jp };
}

export async function pauseService(profileName: string): Promise<{ paused: boolean }> {
  await setPaused(profilePaths(profileName), true);
  return { paused: true };
}

export async function resumeService(profileName: string): Promise<{ paused: boolean }> {
  await setPaused(profilePaths(profileName), false);
  return { paused: false };
}
