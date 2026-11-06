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
function tail(output, lines) {
    const parts = output.split("\n").filter(Boolean);
    return parts.slice(-lines).join("\n");
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
    const defaults = requireChecksDefaults(profile);
    for (const spec of profile.checks) {
        const required = spec.required ?? defaults.requiredDefault;
        const command = resolveCommand(profile, spec.command);
        const files = filesFor(spec, options.changedFiles);
        if (spec.filesOnly && !files.length) {
            results.push({ name: spec.name, ok: true, required, output: "no matching files" });
            continue;
        }
        const args = [...spec.args, ...files];
        const result = await runCommand(command, args, {
            cwd: worktree,
            timeoutMs: spec.timeoutMs ?? defaults.timeoutMs,
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
            output: tail(`${result.stdout}\n${result.stderr}`, defaults.tailLines),
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
function requireChecksDefaults(profile) {
    const defaults = profile.checksDefaults;
    if (!defaults || typeof defaults !== "object") {
        throw new Error("profile.checksDefaults is required (run `auto-work migrate`)");
    }
    const { timeoutMs, tailLines, requiredDefault } = defaults;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("profile.checksDefaults.timeoutMs must be a positive number (run `auto-work migrate`)");
    }
    if (typeof tailLines !== "number" || !Number.isInteger(tailLines) || tailLines <= 0) {
        throw new Error("profile.checksDefaults.tailLines must be a positive integer (run `auto-work migrate`)");
    }
    if (typeof requiredDefault !== "boolean") {
        throw new Error("profile.checksDefaults.requiredDefault must be a boolean (run `auto-work migrate`)");
    }
    return { timeoutMs, tailLines, requiredDefault };
}
function requireSafety(profile) {
    const safety = profile.safety;
    if (!safety || typeof safety !== "object") {
        throw new Error("profile.safety is required (run `auto-work migrate`)");
    }
    const { protectedFiles, secretPatterns } = safety;
    if (!Array.isArray(protectedFiles) ||
        !protectedFiles.length ||
        !protectedFiles.every((entry) => typeof entry === "string")) {
        throw new Error("profile.safety.protectedFiles must be a non-empty string array (run `auto-work migrate`)");
    }
    if (!Array.isArray(secretPatterns) || !secretPatterns.every((entry) => typeof entry === "string")) {
        throw new Error("profile.safety.secretPatterns must be an array of regex strings (run `auto-work migrate`)");
    }
    return { protectedFiles, secretPatterns };
}
function globToRegExp(pattern) {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
}
export function protectedFiles(files, patterns) {
    if (!Array.isArray(patterns)) {
        throw new Error("protected file patterns are required (safety.protectedFiles, run `auto-work migrate`)");
    }
    const regexes = patterns.map((pattern) => pattern.startsWith("re:") ? new RegExp(pattern.slice(3)) : globToRegExp(pattern));
    return files.filter((file) => {
        const normalized = file.replace(/\\/g, "/");
        const base = path.posix.basename(normalized);
        return regexes.some((regex) => regex.test(normalized) || regex.test(base));
    });
}
export function scanSecretsText(text, patterns) {
    if (!Array.isArray(patterns)) {
        throw new Error("secret patterns are required (safety.secretPatterns, run `auto-work migrate`)");
    }
    const hits = [];
    for (const source of patterns) {
        const pattern = new RegExp(source, "i");
        const match = text.match(pattern);
        if (match?.[0])
            hits.push(match[0].slice(0, 80));
    }
    return hits;
}
export function scanSecrets(diff, patterns) {
    const added = diff
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .join("\n");
    return scanSecretsText(added, patterns);
}
//# sourceMappingURL=checks.js.map