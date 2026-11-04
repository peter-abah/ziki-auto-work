import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function envPath(name) {
    const value = process.env[name];
    return value ? path.resolve(value.replace(/^~(?=\/)/, os.homedir())) : undefined;
}
function linuxConfig(home) {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "auto-work");
}
function linuxState(home) {
    return path.join(process.env.XDG_STATE_HOME || path.join(home, ".local/state"), "auto-work");
}
function linuxCache(home) {
    return path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "auto-work");
}
function macConfig(home) {
    return path.join(home, "Library/Preferences/auto-work");
}
function macState(home) {
    return path.join(home, "Library/Application Support/auto-work");
}
function macCache(home) {
    return path.join(home, "Library/Caches/auto-work");
}
function windowsConfig(home) {
    return path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "auto-work");
}
function windowsState(home) {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData/Local"), "auto-work");
}
function windowsCache(home) {
    return path.join(windowsState(home), "cache");
}
export function paths() {
    const home = os.homedir();
    const platform = process.platform;
    const share = envPath("AUTO_WORK_HOME") || PACKAGE_ROOT;
    const configDir = envPath("AUTO_WORK_CONFIG_DIR") ||
        (platform === "darwin" ? macConfig(home) : platform === "win32" ? windowsConfig(home) : linuxConfig(home));
    const stateDir = envPath("AUTO_WORK_STATE_DIR") ||
        (platform === "darwin" ? macState(home) : platform === "win32" ? windowsState(home) : linuxState(home));
    const cacheDir = envPath("AUTO_WORK_CACHE_DIR") ||
        (platform === "darwin" ? macCache(home) : platform === "win32" ? windowsCache(home) : linuxCache(home));
    const bin = platform === "win32"
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
        profilesDir: path.join(stateDir, "profiles"),
        legacyShareDir: path.join(home, ".local/share/auto-work"),
        legacyStateDir: path.join(home, ".local/state/auto-work"),
        packageRoot: PACKAGE_ROOT,
        promptsDir: path.join(share, "prompts"),
        configSamplesDir: path.join(PACKAGE_ROOT, "config"),
        systemdDir: path.join(home, ".config/systemd/user"),
        systemdUnit: path.join(home, ".config/systemd/user/auto-work.service"),
        launchdDir: path.join(home, "Library/LaunchAgents"),
        launchdPlist: path.join(home, "Library/LaunchAgents/io.autowork.plist")
    };
}
export function safeName(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}
export function profilePaths(profileName) {
    const base = path.join(paths().profilesDir, safeName(profileName));
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
        desktopCacheFile: path.join(base, "platform-cache.json"),
        runLimitsFile: path.join(base, "run-limits.json"),
        historyFile: path.join(base, "history.jsonl"),
        lastRunFile: path.join(base, "LAST-RUN.json"),
        lastRunMdFile: path.join(base, "LAST-RUN.md")
    };
}
export function expandHome(value) {
    return value.replace(/^~(?=\/)/, os.homedir());
}
export function isWindows() {
    return process.platform === "win32";
}
export function isMac() {
    return process.platform === "darwin";
}
export function isLinux() {
    return process.platform === "linux";
}
//# sourceMappingURL=paths.js.map