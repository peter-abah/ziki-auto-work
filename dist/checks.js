import { existsSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./platform/paths.js";
import { runCommand } from "./platform/spawn.js";
import { buildCheckEnv } from "./env.js";
export function resolveCommand(profile, command) {
    const mapped = profile.toolchain[command];
    if (mapped) {
        const expanded = expandHome(mapped);
        if (existsSync(expanded))
            return expanded;
        return expanded;
    }
    return command;
}
function tail(output) {
    const lines = output.split("\n").filter(Boolean);
    return lines.slice(-40).join("\n");
}
function normalizeTestPath(url) {
    const raw = String(url ?? "").replace(/^file:\/\//, "");
    const index = raw.indexOf("/test/");
    return index >= 0 ? raw.slice(index + 1) : raw;
}
export function parseTestFailures(output) {
    const tests = new Map();
    const failures = new Set();
    for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{"))
            continue;
        let event;
        try {
            event = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (event.type === "testStart" && event.test) {
            tests.set(event.test.id, event.test);
        }
        if (event.type === "testDone" && ["failure", "error"].includes(event.result) && !event.hidden) {
            const test = tests.get(event.testID);
            if (test)
                failures.add(`${normalizeTestPath(test.url)}::${test.name}`);
        }
    }
    return [...failures];
}
function filesFor(spec, changedFiles) {
    if (!spec.filesOnly)
        return [];
    const include = spec.include?.length ? spec.include : null;
    if (!include)
        return changedFiles;
    return changedFiles.filter((file) => include.some((extension) => file.endsWith(extension)));
}
export async function runChecks(profile, worktree, options) {
    const results = [];
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
        let failures;
        const ok = result.ok;
        if (spec.reporter === "json") {
            failures = parseTestFailures(`${result.stdout}\n${result.stderr}`);
            if (!result.ok && failures.length === 0)
                failures = [`${spec.name} failed (unparsed output)`];
        }
        results.push({
            name: spec.name,
            ok,
            required,
            output: tail(`${result.stdout}\n${result.stderr}`),
            ...(failures ? { failures } : {})
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
function globToRegExp(pattern) {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
}
export function protectedFiles(files, patterns = DEFAULT_PROTECTED) {
    const regexes = patterns.map((pattern) => pattern.startsWith("re:") ? new RegExp(pattern.slice(3)) : globToRegExp(pattern));
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
export function scanSecretsText(text) {
    const hits = [];
    for (const pattern of SECRET_PATTERNS) {
        const match = text.match(pattern);
        if (match?.[0])
            hits.push(match[0].slice(0, 80));
    }
    return hits;
}
export function scanSecrets(diff) {
    const added = diff
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .join("\n");
    return scanSecretsText(added);
}
//# sourceMappingURL=checks.js.map