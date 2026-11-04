import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
function pathHas(dir, pathValue, platform) {
    const wanted = platform === "win32" ? dir.toLowerCase() : dir;
    return pathValue
        .split(path.delimiter)
        .filter(Boolean)
        .some((entry) => (platform === "win32" ? entry.toLowerCase() : entry) === wanted);
}
export function chooseShimPath(options) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const pathValue = options.pathValue ?? env.PATH ?? "";
    if (platform === "win32") {
        const appData = env.APPDATA ? path.join(env.APPDATA, "npm") : null;
        const local = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "auto-work", "bin") : null;
        const candidates = [appData, local].filter((value) => Boolean(value));
        const found = candidates.find((dir) => existsSync(dir)) ?? candidates[0];
        if (!found)
            return null;
        return { path: path.join(found, "auto-work.cmd"), dir: found, onPath: pathHas(found, pathValue, platform) };
    }
    const candidates = [path.join(options.home, ".local/bin"), path.join(options.home, "bin")];
    const onPath = candidates.find((dir) => existsSync(dir) && pathHas(dir, pathValue, platform));
    const existing = candidates.find((dir) => existsSync(dir));
    const found = onPath ?? existing ?? candidates[0];
    return { path: path.join(found, "auto-work"), dir: found, onPath: pathHas(found, pathValue, platform) };
}
export async function installShim(options) {
    const platform = options.platform ?? process.platform;
    const plan = chooseShimPath({
        platform,
        home: options.home,
        env: options.env,
        pathValue: options.pathValue
    });
    if (!plan)
        return null;
    const target = path.join(options.packageRoot, "bin", "auto-work.mjs");
    await mkdir(plan.dir, { recursive: true });
    if (platform === "win32") {
        const content = `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`;
        const existing = existsSync(plan.path) ? await readFile(plan.path, "utf8").catch(() => "") : "";
        await writeFile(plan.path, content, "utf8");
        return { plan, target, created: existing !== content };
    }
    await unlink(plan.path).catch(() => { });
    await symlink(target, plan.path);
    await chmod(target, 0o755).catch(() => { });
    return { plan, target, created: true };
}
//# sourceMappingURL=shim.js.map