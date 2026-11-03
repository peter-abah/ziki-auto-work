import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { jobPaths, paths, safeName } from "./platform/paths.js";
import { runCommand, spawnDetached } from "./platform/spawn.js";
import {
  clearPid,
  isPaused,
  isStopped,
  readPid,
  setPaused,
  setStopped
} from "./state.js";

function binPath(): string {
  return path.join(paths().packageRoot, "bin/auto-work.mjs");
}

function unitName(jobName: string): string {
  return `auto-work-${safeName(jobName)}`;
}

export function systemdUnitText(jobName: string): string {
  return `[Unit]
Description=auto-work (${jobName})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${paths().home}
ExecStart=${process.execPath} ${binPath()} start --foreground --job ${jobName}
Restart=on-failure
RestartSec=15
Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}

[Install]
WantedBy=default.target
`;
}

export function launchdPlistText(jobName: string): string {
  const jp = jobPaths(jobName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.autowork.${safeName(jobName)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binPath()}</string>
    <string>start</string>
    <string>--foreground</string>
    <string>--job</string>
    <string>${jobName}</string>
  </array>
  <key>WorkingDirectory</key><string>${paths().home}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${path.join(jp.logsDir, "service.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(jp.logsDir, "service.error.log")}</string>
</dict>
</plist>
`;
}

function windowsCmdText(jobName: string): string {
  return `@echo off\r\n"${process.execPath}" "${binPath()}" start --foreground --job ${jobName}\r\n`;
}

export async function installService(jobName: string): Promise<{ ok: boolean; mode: string; file: string; detail?: string }> {
  const p = paths();
  if (process.platform === "linux") {
    await mkdir(p.systemdDir, { recursive: true });
    const file = path.join(p.systemdDir, `${unitName(jobName)}.service`);
    await writeFile(file, systemdUnitText(jobName), "utf8");
    const reload = await runCommand("systemctl", ["--user", "daemon-reload"]);
    const enable = await runCommand("systemctl", ["--user", "enable", `${unitName(jobName)}.service`]);
    return { ok: reload.ok && enable.ok, mode: "systemd", file, detail: enable.stderr || reload.stderr };
  }
  if (process.platform === "darwin") {
    await mkdir(p.launchdDir, { recursive: true });
    const file = path.join(p.launchdDir, `io.autowork.${safeName(jobName)}.plist`);
    await writeFile(file, launchdPlistText(jobName), "utf8");
    const load = await runCommand("launchctl", ["load", "-w", file]);
    return { ok: load.ok, mode: "launchd", file, detail: load.stderr };
  }
  if (process.platform === "win32") {
    const dir = path.dirname(p.bin);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${unitName(jobName)}.cmd`);
    await writeFile(file, windowsCmdText(jobName), "utf8");
    const task = await runCommand("schtasks", [
      "/Create",
      "/SC",
      "ONLOGON",
      "/TN",
      unitName(jobName),
      "/TR",
      file,
      "/F"
    ]);
    return { ok: task.ok, mode: "task-scheduler", file, detail: task.stderr };
  }
  return { ok: false, mode: "unsupported", file: "", detail: `unsupported platform ${process.platform}` };
}

export async function startService(jobName: string): Promise<{ mode: string; pid?: number }> {
  const jp = jobPaths(jobName);
  const existing = await readPid(jp);
  if (existing) return { mode: "already-running", pid: existing };
  await unlink(jp.stopFile).catch(() => {});

  if (process.platform === "linux") {
    const unit = `${unitName(jobName)}.service`;
    const unitFile = path.join(paths().systemdDir, unit);
    if (existsSync(unitFile)) {
      const result = await runCommand("systemctl", ["--user", "start", unit]);
      if (result.ok) return { mode: "systemd" };
    }
  }
  if (process.platform === "darwin") {
    const plist = path.join(paths().launchdDir, `io.autowork.${safeName(jobName)}.plist`);
    if (existsSync(plist)) {
      const result = await runCommand("launchctl", ["load", "-w", plist]);
      if (result.ok) return { mode: "launchd" };
    }
  }
  if (process.platform === "win32") {
    const result = await runCommand("schtasks", ["/Run", "/TN", unitName(jobName)]);
    if (result.ok) return { mode: "task-scheduler" };
  }

  const child = spawnDetached(process.execPath, [binPath(), "start", "--foreground", "--job", jobName], {
    cwd: paths().home
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { mode: "detached", pid: child.pid };
}

export async function stopService(jobName: string): Promise<{ stopped: boolean; pid: number | null }> {
  const jp = jobPaths(jobName);
  await setStopped(jp, true);

  if (process.platform === "linux") {
    await runCommand("systemctl", ["--user", "stop", `${unitName(jobName)}.service`]);
  } else if (process.platform === "darwin") {
    const plist = path.join(paths().launchdDir, `io.autowork.${safeName(jobName)}.plist`);
    await runCommand("launchctl", ["unload", "-w", plist]);
  } else if (process.platform === "win32") {
    await runCommand("schtasks", ["/End", "/TN", unitName(jobName)]);
  }

  const pid = await readPid(jp);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await clearPid(jp);
  await unlink(jp.stopFile).catch(() => {});
  return { stopped: true, pid };
}

export async function statusService(jobName: string): Promise<{
  pid: number | null;
  running: boolean;
  paused: boolean;
  stopped: boolean;
  status: Record<string, unknown> | null;
  jobPaths: ReturnType<typeof jobPaths>;
}> {
  const jp = jobPaths(jobName);
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
  return { pid, running: Boolean(pid), paused, stopped, status, jobPaths: jp };
}

export async function pauseService(jobName: string): Promise<{ paused: boolean }> {
  await setPaused(jobPaths(jobName), true);
  return { paused: true };
}

export async function resumeService(jobName: string): Promise<{ paused: boolean }> {
  await setPaused(jobPaths(jobName), false);
  return { paused: false };
}
