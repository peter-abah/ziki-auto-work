import { existsSync } from "node:fs";
import { readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { PACKAGE_ROOT, paths, profilePaths, safeName } from "./platform/paths.js";
import { runCommand } from "./platform/spawn.js";
async function profileNames() {
    try {
        const config = await loadConfig();
        return Object.keys(config.profiles ?? {});
    }
    catch {
        return [];
    }
}
function underHome(target) {
    const home = path.resolve(paths().home);
    const resolved = path.resolve(target);
    const relative = path.relative(home, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function removable(target) {
    const resolved = path.resolve(target);
    const home = path.resolve(paths().home);
    if (resolved === home)
        return false;
    if (resolved === path.resolve(PACKAGE_ROOT))
        return false;
    return underHome(resolved);
}
async function serviceItems(names) {
    const p = paths();
    const items = [];
    if (process.platform === "linux" && existsSync(p.systemdDir)) {
        const files = await readdir(p.systemdDir).catch(() => []);
        for (const file of files.filter((entry) => /^auto-work-.*\.service$/.test(entry))) {
            const target = path.join(p.systemdDir, file);
            items.push({ kind: "systemd", label: `systemd unit ${file}`, path: target, exists: true });
        }
    }
    if (process.platform === "darwin" && existsSync(p.launchdDir)) {
        const files = await readdir(p.launchdDir).catch(() => []);
        for (const file of files.filter((entry) => /^io\.autowork\..*\.plist$/.test(entry))) {
            const target = path.join(p.launchdDir, file);
            items.push({ kind: "launchd", label: `launchd agent ${file}`, path: target, exists: true });
        }
    }
    if (process.platform === "win32") {
        const dir = path.dirname(p.bin);
        const files = existsSync(dir) ? await readdir(dir).catch(() => []) : [];
        const fromFiles = files
            .filter((entry) => /^auto-work-.*\.cmd$/.test(entry))
            .map((entry) => entry.replace(/\.cmd$/, ""));
        const tasks = [...new Set([...names.map((name) => `auto-work-${safeName(name)}`), ...fromFiles])];
        for (const task of tasks) {
            items.push({
                kind: "task",
                label: `scheduled task ${task}`,
                path: path.join(dir, `${task}.cmd`),
                exists: existsSync(path.join(dir, `${task}.cmd`)),
                taskName: task
            });
        }
    }
    return items;
}
export async function planUninstall(options) {
    const p = paths();
    const names = await profileNames();
    const items = [...(await serviceItems(names))];
    items.push({ kind: "bin", label: "command shim", path: p.bin, exists: existsSync(p.bin) });
    if (!options.keepData) {
        items.push({ kind: "config", label: "config, env and prompts", path: p.configDir, exists: existsSync(p.configDir) });
        items.push({ kind: "state", label: "profiles, logs and worktrees", path: p.stateDir, exists: existsSync(p.stateDir) });
        items.push({ kind: "cache", label: "cache", path: p.cacheDir, exists: existsSync(p.cacheDir) });
        const known = new Set([p.configDir, p.stateDir, p.cacheDir, p.bin, PACKAGE_ROOT].map((target) => path.resolve(target)));
        for (const [label, target] of [
            ["legacy install (~/.local/share/auto-work)", p.legacyShareDir],
            ["legacy state (~/.local/state/auto-work)", p.legacyStateDir]
        ]) {
            if (known.has(path.resolve(target)))
                continue;
            items.push({ kind: "legacy", label, path: target, exists: existsSync(target) });
        }
    }
    const seen = new Set();
    return items.filter((item) => {
        const key = `${item.kind}:${path.resolve(item.path)}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function printPlan(items, options) {
    console.log(options.dryRun ? "Uninstall plan (dry run — nothing will be removed):" : "Uninstall will remove:");
    console.log("");
    for (const item of items) {
        const state = item.exists ? "" : "  (not present)";
        console.log(`  ${item.kind.padEnd(8)} ${item.path}${state}`);
    }
    console.log("");
    if (options.keepData) {
        console.log("Keeping config, state and cache (--keep-data).");
    }
    else {
        console.log("This removes config, keys, state, logs, worktrees and cloned repos.");
    }
    if (items.some((item) => !removable(item.path) && item.kind !== "task")) {
        console.log("Some paths are outside your home directory and will be skipped.");
    }
}
async function confirm() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question("Type 'yes' to continue: ")).trim().toLowerCase();
        return answer === "yes" || answer === "y";
    }
    finally {
        rl.close();
    }
}
async function stopLoops(names) {
    for (const name of names) {
        const raw = await readFile(profilePaths(name).pidFile, "utf8").catch(() => "");
        const pid = Number(raw.trim());
        if (!pid)
            continue;
        try {
            process.kill(pid, "SIGTERM");
        }
        catch {
            // already gone
        }
    }
}
async function removeItem(item) {
    if (!item.exists)
        return;
    if (!removable(item.path) && item.kind !== "task") {
        console.log(`  skipped (outside home): ${item.path}`);
        return;
    }
    if (item.kind === "systemd") {
        const unit = path.basename(item.path);
        await runCommand("systemctl", ["--user", "disable", "--now", unit]).catch(() => { });
        await unlink(item.path).catch(() => { });
        return;
    }
    if (item.kind === "launchd") {
        await runCommand("launchctl", ["unload", "-w", item.path]).catch(() => { });
        await unlink(item.path).catch(() => { });
        return;
    }
    if (item.kind === "task") {
        if (item.taskName)
            await runCommand("schtasks", ["/Delete", "/TN", item.taskName, "/F"]).catch(() => { });
        await unlink(item.path).catch(() => { });
        return;
    }
    await rm(item.path, { recursive: true, force: true });
}
export async function runUninstall(options) {
    const p = paths();
    const names = await profileNames();
    const items = await planUninstall({ keepData: options.keepData });
    printPlan(items, options);
    if (options.dryRun) {
        console.log("");
        console.log(`Then remove the package: npm uninstall -g ziki-auto-work`);
        return;
    }
    if (!options.yes) {
        const ok = await confirm();
        if (!ok) {
            console.log("Cancelled.");
            return;
        }
    }
    await stopLoops(names);
    for (const item of items) {
        await removeItem(item);
    }
    console.log("");
    console.log("auto-work removed.");
    console.log("Remove the package itself:");
    console.log("  npm uninstall -g ziki-auto-work");
    if (!options.keepData) {
        console.log(`Config was ${p.configFile}; keys were ${p.envFile}.`);
    }
}
//# sourceMappingURL=uninstall.js.map