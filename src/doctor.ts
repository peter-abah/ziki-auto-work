import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import type { ProfileConfig } from "./types.js";
import { loadConfig, loadProfile, resolveModel, validateConfig } from "./config.js";
import { getProvider } from "./providers/index.js";
import { GitHub } from "./github.js";
import { readPid } from "./state.js";
import { expandHome, paths } from "./platform/paths.js";
import { runCommand } from "./platform/spawn.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}

export async function runDoctor(options: { profileName?: string } = {}): Promise<{
  ok: boolean;
  checks: DoctorCheck[];
}> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, critical = true): void => {
    checks.push({ name, ok, detail, critical });
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 20, `v${process.versions.node}`);

  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    add("config", false, error instanceof Error ? error.message : String(error));
    return { ok: false, checks };
  }
  const validation = validateConfig(config);
  add("config", validation.ok, validation.ok ? paths().configFile : validation.errors.join("; "));

  let loaded;
  try {
    loaded = await loadProfile(options.profileName);
    add("profile", true, loaded.profileName);
  } catch (error) {
    add("profile", false, error instanceof Error ? error.message : String(error));
    return { ok: false, checks };
  }

  const { profile, profileName, profilePaths: jp, keys } = loaded;
  const allKeys = [...keys.workers, ...keys.managers];
  add("agent keys", allKeys.length >= 1, `${keys.workers.length} workers, ${keys.managers.length} managers`);

  for (const agent of allKeys) {
    try {
      const { clientForAgent } = await import("./ziki.js");
      const client = clientForAgent(agent, profile);
      const me = await client.me();
      const project = me?.project_slug ? ` · ${me.project_slug}` : "";
      add(`key ${agent.name}`, true, `${me.name} (${me.level})${project}`);
    } catch (error) {
      add(`key ${agent.name}`, false, error instanceof Error ? error.message : String(error));
    }
  }
  add(
    "manager key",
    keys.managers.length > 0,
    keys.managers.length ? `${keys.managers.length} manager/merger` : "no manager/merger key (awards and merge reviews disabled)",
    false
  );

  const provider = getProvider(profile.executor.provider, profile);
  try {
    const result = await provider.doctor(profile);
    add(`provider ${profile.executor.provider}`, result.ok, result.detail);
  } catch (error) {
    add(`provider ${profile.executor.provider}`, false, error instanceof Error ? error.message : String(error));
  }

  const git = profile.toolchain.git || "git";
  const gh = profile.toolchain.gh || "gh";
  const gitVersion = await runCommand(git, ["--version"]);
  add("git", gitVersion.ok, gitVersion.stdout || gitVersion.stderr);

  const ghVersion = await runCommand(gh, ["--version"]);
  add("gh", ghVersion.ok, ghVersion.stdout.split("\n")[0] || ghVersion.stderr);

  const ghAuth = await runCommand(gh, ["auth", "status"]);
  add("gh auth", ghAuth.ok, ghAuth.ok ? "authenticated" : ghAuth.stderr.split("\n").slice(0, 2).join(" "));

  for (const [name, command] of Object.entries(profile.toolchain)) {
    if (["git", "gh"].includes(name)) continue;
    const result = await runCommand(expandHome(command), ["--version"], { timeoutMs: 20_000 });
    add(`toolchain ${name}`, result.ok, result.ok ? result.stdout.split("\n")[0] || "ok" : result.stderr, false);
  }

  const checkCommands = new Set(
    profile.checks.map((check) => check.command).filter((command) => !profile.toolchain[command])
  );
  for (const command of checkCommands) {
    const result = await runCommand(command, ["--version"], { timeoutMs: 20_000 });
    add(`check tool ${command}`, result.ok, result.ok ? result.stdout.split("\n")[0] || "ok" : result.stderr, false);
  }

  try {
    const github = new GitHub({ profile, profileName, reposDir: jp.reposDir });
    const repoDir = await github.ensureRepo();
    add("repo clone", true, repoDir);
    const base = await github.git(["rev-parse", "--verify", `upstream/${profile.repo.base}`]);
    add(`base upstream/${profile.repo.base}`, base.ok, base.stdout.slice(0, 12) || base.stderr);
  } catch (error) {
    add("repo", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const github = new GitHub({ profile, profileName, reposDir: jp.reposDir });
    const result = await github.remoteAccess(profile.repo.url);
    add("fork access", result.ok, result.ok ? profile.repo.url : result.stderr.split("\n")[0] || "failed");
  } catch (error) {
    add("fork access", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const stats = await statfs(jp.stateDir);
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    add("disk", freeGb > 3, `${freeGb.toFixed(1)} GB free`);
  } catch {
    add("disk", true, "could not read (not critical)", false);
  }

  try {
    const modelList = await provider.models(profile);
    const roles = ["worker", "review", "triage", "confirm", "discovery", "owner"] as const;
    for (const role of roles) {
      const model = resolveModel(profile, role);
      if (model && modelList.items.length && !modelList.items.includes(model)) {
        add(`model ${role}`, true, `${model} (not in provider list; allowed)`, false);
      } else {
        add(`model ${role}`, true, model ?? "(provider default)", false);
      }
    }
  } catch (error) {
    add("models", true, error instanceof Error ? error.message : String(error), false);
  }

  const pid = await readPid(jp);
  add("loop", true, pid ? `already running (pid ${pid})` : "not running", false);

  const criticalFailures = checks.filter((check) => check.critical && !check.ok);
  return { ok: criticalFailures.length === 0, checks };
}

export function formatDoctor(result: { ok: boolean; checks: DoctorCheck[] }): string {
  const lines = ["Auto-work doctor", ""];
  for (const check of result.checks) {
    const mark = check.ok ? "ok  " : check.critical ? "FAIL" : "warn";
    lines.push(`  ${mark}  ${check.name.padEnd(24)} ${check.detail}`);
  }
  lines.push("", result.ok ? "Ready." : "Not ready: fix the FAIL lines above.");
  return lines.join("\n");
}

export function doctorConfigPath(): string {
  return paths().configFile;
}

export function doctorConfigExists(): boolean {
  return existsSync(paths().configFile);
}
