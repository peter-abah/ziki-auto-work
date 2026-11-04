import { existsSync } from "node:fs";
import path from "node:path";
import type { ProfileConfig } from "./types.js";
import { expandHome } from "./platform/paths.js";

export function toolchainDirs(profile: ProfileConfig): string[] {
  const dirs: string[] = [];
  for (const value of Object.values(profile.toolchain ?? {})) {
    if (!value) continue;
    const expanded = expandHome(value);
    if (!expanded.includes("/") && !expanded.includes("\\")) continue;
    const dir = path.dirname(expanded);
    if (dirs.includes(dir)) continue;
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

export function toolchainPath(profile: ProfileConfig, base = process.env.PATH || ""): string {
  const dirs = toolchainDirs(profile);
  if (!dirs.length) return base;
  const parts = base.split(path.delimiter).filter(Boolean);
  for (const dir of [...dirs].reverse()) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return parts.join(path.delimiter);
}

export function buildAgentEnv(
  profile: ProfileConfig,
  providerEnv: Record<string, string> | undefined,
  extraEnv: Record<string, string> | undefined
): Record<string, string> {
  const env: Record<string, string> = { ...(profile.executor.env ?? {}) };
  if (providerEnv) Object.assign(env, providerEnv);
  if (extraEnv) Object.assign(env, extraEnv);
  if (toolchainDirs(profile).length) env.PATH = toolchainPath(profile, env.PATH ?? process.env.PATH ?? "");
  return env;
}

export function buildCheckEnv(
  profile: ProfileConfig,
  checkEnv: Record<string, string> | undefined
): Record<string, string> {
  const env: Record<string, string> = { ...(profile.executor.env ?? {}) };
  if (checkEnv) Object.assign(env, checkEnv);
  if (toolchainDirs(profile).length) env.PATH = toolchainPath(profile, env.PATH ?? process.env.PATH ?? "");
  return env;
}

export function envFilesFor(profile: ProfileConfig): string[] {
  const files = profile.repo.envFiles;
  return files && files.length ? files : [".env", ".env.local"];
}
