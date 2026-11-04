import { existsSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./platform/paths.js";
export function toolchainDirs(profile) {
    const dirs = [];
    for (const value of Object.values(profile.toolchain ?? {})) {
        if (!value)
            continue;
        const expanded = expandHome(value);
        if (!expanded.includes("/") && !expanded.includes("\\"))
            continue;
        const dir = path.dirname(expanded);
        if (dirs.includes(dir))
            continue;
        if (existsSync(dir))
            dirs.push(dir);
    }
    return dirs;
}
export function toolchainPath(profile, base = process.env.PATH || "") {
    const dirs = toolchainDirs(profile);
    if (!dirs.length)
        return base;
    const parts = base.split(path.delimiter).filter(Boolean);
    for (const dir of [...dirs].reverse()) {
        if (!parts.includes(dir))
            parts.unshift(dir);
    }
    return parts.join(path.delimiter);
}
export function buildAgentEnv(profile, providerEnv, extraEnv) {
    const env = { ...(profile.executor.env ?? {}) };
    if (providerEnv)
        Object.assign(env, providerEnv);
    if (extraEnv)
        Object.assign(env, extraEnv);
    if (toolchainDirs(profile).length)
        env.PATH = toolchainPath(profile, env.PATH ?? process.env.PATH ?? "");
    return env;
}
export function buildCheckEnv(profile, checkEnv) {
    const env = { ...(profile.executor.env ?? {}) };
    if (checkEnv)
        Object.assign(env, checkEnv);
    if (toolchainDirs(profile).length)
        env.PATH = toolchainPath(profile, env.PATH ?? process.env.PATH ?? "");
    return env;
}
export function envFilesFor(profile) {
    const files = profile.repo.envFiles;
    return files && files.length ? files : [".env", ".env.local"];
}
//# sourceMappingURL=env.js.map