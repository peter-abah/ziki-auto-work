import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobPaths, Paths } from "../types.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value ? path.resolve(value.replace(/^~(?=\/)/, os.homedir())) : undefined;
}

function linuxConfig(home: string): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "auto-work");
}

function linuxState(home: string): string {
  return path.join(process.env.XDG_STATE_HOME || path.join(home, ".local/state"), "auto-work");
}

function linuxCache(home: string): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "auto-work");
}

function macConfig(home: string): string {
  return path.join(home, "Library/Preferences/auto-work");
}

function macState(home: string): string {
  return path.join(home, "Library/Application Support/auto-work");
}

function macCache(home: string): string {
  return path.join(home, "Library/Caches/auto-work");
}

function windowsConfig(home: string): string {
  return path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "auto-work");
}

function windowsState(home: string): string {
  return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData/Local"), "auto-work");
}

function windowsCache(home: string): string {
  return path.join(windowsState(home), "cache");
}

export function paths(): Paths {
  const home = os.homedir();
  const platform = process.platform;
  const share = envPath("AUTO_WORK_HOME") || PACKAGE_ROOT;
  const configDir =
    envPath("AUTO_WORK_CONFIG_DIR") ||
    (platform === "darwin" ? macConfig(home) : platform === "win32" ? windowsConfig(home) : linuxConfig(home));
  const stateDir =
    envPath("AUTO_WORK_STATE_DIR") ||
    (platform === "darwin" ? macState(home) : platform === "win32" ? windowsState(home) : linuxState(home));
  const cacheDir =
    envPath("AUTO_WORK_CACHE_DIR") ||
    (platform === "darwin" ? macCache(home) : platform === "win32" ? windowsCache(home) : linuxCache(home));
  const bin =
    platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(home, "AppData/Local"), "auto-work", "bin", "auto-work.cmd")
      : path.join(home, ".local/bin/auto-work");

  return {
    home,
    share,
    configDir,
    configFile: path.join(configDir, "config.json"),
    envFile: path.join(configDir, "env"),
    stateDir,
    cacheDir,
    bin,
    jobsDir: path.join(stateDir, "jobs"),
    packageRoot: PACKAGE_ROOT,
    promptsDir: path.join(share, "prompts"),
    configSamplesDir: path.join(PACKAGE_ROOT, "config"),
    systemdDir: path.join(home, ".config/systemd/user"),
    systemdUnit: path.join(home, ".config/systemd/user/auto-work.service"),
    launchdDir: path.join(home, "Library/LaunchAgents"),
    launchdPlist: path.join(home, "Library/LaunchAgents/io.autowork.plist")
  };
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function jobPaths(jobName: string): JobPaths {
  const base = path.join(paths().jobsDir, safeName(jobName));
  return {
    stateDir: base,
    stateFile: path.join(base, "state.json"),
    statusFile: path.join(base, "status.json"),
    logsDir: path.join(base, "logs"),
    worktreesDir: path.join(base, "worktrees"),
    reposDir: path.join(base, "repos"),
    resultsDir: path.join(base, "results"),
    lockFile: path.join(base, "auto-work.lock"),
    pidFile: path.join(base, "auto-work.pid"),
    pauseFile: path.join(base, "PAUSE"),
    stopFile: path.join(base, "STOP"),
    needsHumanFile: path.join(base, "NEEDS-HUMAN.md"),
    ownerRequestsFile: path.join(base, "OWNER-REQUESTS.md"),
    memoryFile: path.join(base, "memory-context.json"),
    desktopCacheFile: path.join(base, "platform-cache.json")
  };
}

export function expandHome(value: string): string {
  return value.replace(/^~(?=\/)/, os.homedir());
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}
