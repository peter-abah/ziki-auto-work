import { existsSync } from "node:fs";
import path from "node:path";
import type { CheckResult, CheckRunResult, CheckSpec, ProfileConfig } from "./types.js";
import { expandHome } from "./platform/paths.js";
import { runCommand } from "./platform/spawn.js";
import { buildCheckEnv } from "./env.js";
import type { Logger } from "./log.js";

export function resolveCommand(profile: ProfileConfig, command: string): string {
  const mapped = profile.toolchain[command];
  if (mapped) {
    const expanded = expandHome(mapped);
    if (existsSync(expanded)) return expanded;
    return expanded;
  }
  return command;
}

function tail(output: string): string {
  const lines = output.split("\n").filter(Boolean);
  return lines.slice(-40).join("\n");
}

function normalizeTestPath(url: unknown): string {
  const raw = String(url ?? "").replace(/^file:\/\//, "");
  const index = raw.indexOf("/test/");
  return index >= 0 ? raw.slice(index + 1) : raw;
}

export function parseTestFailures(output: string): string[] {
  const tests = new Map<number, { name?: string; url?: string }>();
  const failures = new Set<string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "testStart" && event.test) {
      tests.set(event.test.id, event.test);
    }
    if (event.type === "testDone" && ["failure", "error"].includes(event.result) && !event.hidden) {
      const test = tests.get(event.testID);
      if (test) failures.add(`${normalizeTestPath(test.url)}::${test.name}`);
    }
  }
  return [...failures];
}

function filesFor(spec: CheckSpec, changedFiles: string[]): string[] {
  if (!spec.filesOnly) return [];
  const include = spec.include?.length ? spec.include : null;
  if (!include) return changedFiles;
  return changedFiles.filter((file) => include.some((extension) => file.endsWith(extension)));
}

export async function runChecks(
  profile: ProfileConfig,
  worktree: string,
  options: {
    changedFiles: string[];
    baselineFailures?: Record<string, string[]>;
    logger?: Logger;
  }
): Promise<CheckRunResult> {
  const results: CheckResult[] = [];
  const baselineAll = options.baselineFailures ?? {};

  for (const spec of profile.checks) {
    const required = spec.required !== false;
    const command = resolveCommand(profile, spec.command);
    const files = filesFor(spec, options.changedFiles);

    if (spec.filesOnly && !files.length) {
      results.push({ name: spec.name, ok: true, required, output: "no matching files" });
      continue;
    }

    const args = [...spec.args, ...files];
    const result = await runCommand(command, args, {
      cwd: worktree,
      timeoutMs: spec.timeoutMs ?? 20 * 60 * 1000,
      env: buildCheckEnv(profile, spec.env)
    });

    let failures: string[] | undefined;
    let newFailures: string[] | undefined;
    let ok = result.ok;

    if (spec.reporter === "json") {
      failures = parseTestFailures(`${result.stdout}\n${result.stderr}`);
      if (!result.ok && failures.length === 0) failures = [`${spec.name} failed (unparsed output)`];
      const baseline = baselineAll[spec.name] ?? [];
      newFailures = failures.filter((failure) => !baseline.includes(failure));
      ok = result.ok || (baseline.length > 0 && newFailures.length === 0);
    } else if (spec.baseline) {
      failures = result.ok ? [] : [`${spec.name} failed`];
      const baseline = baselineAll[spec.name] ?? [];
      newFailures = failures.filter((failure) => !baseline.includes(failure));
      ok = result.ok || (baseline.length > 0 && newFailures.length === 0);
    }

    results.push({
      name: spec.name,
      ok,
      required,
      output: tail(`${result.stdout}\n${result.stderr}`),
      ...(failures ? { failures } : {}),
      ...(newFailures ? { newFailures } : {})
    });

    options.logger?.info(`Check ${spec.name}: ${ok ? "pass" : "fail"}`, {
      required,
      failures: failures?.slice(0, 5)
    });
  }

  const ok = results.every((result) => result.ok || !result.required);
  return { ok, results };
}

export const DEFAULT_PROTECTED = [
  ".github/**",
  "AGENTS.md",
  "CONTRIBUTING.md",
  ".env",
  ".env.*",
  "*.p12",
  "*.pfx",
  "*.pem",
  "*.p8",
  "*.jks",
  "*.keystore"
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function protectedFiles(files: string[], patterns: string[] = DEFAULT_PROTECTED): string[] {
  const regexes = patterns.map((pattern) =>
    pattern.startsWith("re:") ? new RegExp(pattern.slice(3)) : globToRegExp(pattern)
  );
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, "/");
    const base = path.posix.basename(normalized);
    return regexes.some((regex) => regex.test(normalized) || regex.test(base));
  });
}

const SECRET_PATTERNS = [
  /ZIKI_KEY[A-Z0-9_]*\s*=\s*\S+/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /\bpassword\s*[:=]\s*["'][^"']{4,}["']/i
];

export function scanSecrets(diff: string): string[] {
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const match = added.match(pattern);
    if (match?.[0]) hits.push(match[0].slice(0, 80));
  }
  return hits;
}
