import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../platform/spawn.js";
function modelArgs(provider, model) {
    if (!model)
        return [];
    switch (provider) {
        case "codex":
        case "gemini":
            return ["-m", model];
        case "opencode":
        case "claude":
            return ["--model", model];
        default:
            return [];
    }
}
function extra(profile) {
    return profile.executor.extraArgs ?? [];
}
function promptMode(profile) {
    return profile.executor.promptMode ?? "arg";
}
function opencode(profile) {
    const command = profile.executor.command || "opencode";
    return {
        name: "opencode",
        build({ prompt, cwd, model }) {
            const args = ["run", "--auto", "--format", "default", "--dir", cwd, ...modelArgs("opencode", model), ...extra(profile)];
            if (promptMode(profile) === "stdin")
                return { command, args, stdin: prompt };
            return { command, args: [...args, prompt] };
        },
        async doctor() {
            const result = await runCommand(command, ["--version"], { timeoutMs: 20_000 });
            return { ok: result.ok, detail: result.ok ? result.stdout.split("\n")[0] || "ok" : result.stderr };
        },
        async models() {
            const result = await runCommand(command, ["models"], { timeoutMs: 60_000 });
            if (!result.ok)
                return { items: [], note: result.stderr || "could not list models" };
            return { items: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
        }
    };
}
function claude(profile) {
    const command = profile.executor.command || "claude";
    const permission = profile.executor.permissionMode === "safe"
        ? ["--permission-mode", "acceptEdits"]
        : ["--dangerously-skip-permissions"];
    return {
        name: "claude",
        build({ prompt, cwd, model }) {
            const args = ["-p", ...permission, ...modelArgs("claude", model), ...extra(profile)];
            if (promptMode(profile) === "stdin")
                return { command, args, stdin: prompt };
            return { command, args: [...args, prompt] };
        },
        async doctor() {
            const result = await runCommand(command, ["--version"], { timeoutMs: 20_000 });
            return { ok: result.ok, detail: result.ok ? result.stdout.split("\n")[0] || "ok" : result.stderr };
        },
        async models() {
            return {
                items: ["sonnet", "opus", "haiku"],
                note: "Aliases are stable; full model names are also accepted."
            };
        }
    };
}
function codex(profile) {
    const command = profile.executor.command || "codex";
    const permission = profile.executor.permissionMode === "safe"
        ? ["-s", "workspace-write"]
        : ["--dangerously-bypass-approvals-and-sandbox"];
    return {
        name: "codex",
        build({ prompt, cwd, model }) {
            const args = ["exec", ...permission, "-C", cwd, ...modelArgs("codex", model), ...extra(profile)];
            if (promptMode(profile) === "stdin")
                return { command, args, stdin: prompt };
            return { command, args: [...args, prompt] };
        },
        async doctor() {
            const result = await runCommand(command, ["--version"], { timeoutMs: 20_000 });
            return { ok: result.ok, detail: result.ok ? result.stdout.split("\n")[0] || "ok" : result.stderr };
        },
        async models() {
            const configFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
            if (!existsSync(configFile))
                return { items: [], note: `no ${configFile}; pass a model with -m` };
            const text = await readFile(configFile, "utf8");
            const models = new Set();
            for (const line of text.split(/\r?\n/)) {
                const match = line.match(/^\s*model\s*=\s*"([^"]+)"/);
                if (match?.[1])
                    models.add(match[1]);
            }
            return { items: [...models], note: "Read from ~/.codex/config.toml; -m overrides." };
        }
    };
}
function gemini(profile) {
    const command = profile.executor.command || "gemini";
    const permission = profile.executor.permissionMode === "safe" ? ["--approval-mode", "auto_edit"] : ["--yolo", "--skip-trust"];
    return {
        name: "gemini",
        build({ prompt, cwd, model }) {
            const args = ["-p", ...permission, ...modelArgs("gemini", model), ...extra(profile)];
            if (promptMode(profile) === "stdin")
                return { command, args, stdin: prompt };
            return { command, args: [...args, prompt] };
        },
        async doctor() {
            const result = await runCommand(command, ["--version"], { timeoutMs: 20_000 });
            return { ok: result.ok, detail: result.ok ? result.stdout.split("\n")[0] || "ok" : result.stderr };
        },
        async models() {
            return { items: [], note: "Gemini has no list command; pass a model name with -m." };
        }
    };
}
function custom(profile) {
    const command = profile.executor.command || "";
    const template = profile.executor.args ?? [];
    const render = (value, vars) => value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => vars[key] ?? "");
    return {
        name: "custom",
        build({ prompt, cwd, model, resultPath }) {
            const vars = { prompt, cwd, model: model ?? "", resultPath };
            const args = template.map((arg) => render(arg, vars));
            if (promptMode(profile) === "stdin")
                return { command, args, stdin: prompt };
            const hasPrompt = template.some((arg) => arg.includes("{{prompt}}"));
            return { command, args: hasPrompt ? args : [...args, prompt] };
        },
        async doctor() {
            if (!command)
                return { ok: false, detail: "executor.command is required for provider custom" };
            const result = await runCommand(command, ["--version"], { timeoutMs: 20_000 });
            return { ok: result.ok, detail: result.ok ? result.stdout.split("\n")[0] || "ok" : result.stderr };
        },
        async models() {
            return { items: [], note: "custom provider: model is whatever your command accepts" };
        }
    };
}
const ADAPTERS = {
    opencode,
    claude,
    codex,
    gemini,
    custom
};
export function getProvider(name, profile) {
    const factory = ADAPTERS[name];
    if (!factory)
        throw new Error(`Unknown provider "${name}"`);
    return factory(profile);
}
export function providerCommand(profile, input) {
    return getProvider(profile.executor.provider, profile).build(input);
}
//# sourceMappingURL=index.js.map