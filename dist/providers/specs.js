/**
 * Experimental headless specs for popular CLIs. Verify flags against the
 * installed version before relying on them; users can override any spec in
 * `providers` in the config.
 */
export const SHORTLIST_SPECS = {
    aider: {
        id: "aider",
        label: "Aider",
        command: "aider",
        args: ["--yes", "--no-auto-commits", "--no-check-update", "--message", "{{prompt}}"],
        promptMode: "arg",
        resultMode: "stdout",
        modelArgs: ["--model", "{{model}}"],
        doctorArgs: ["--version"],
        usage: { estimate: true },
        experimental: true
    },
    goose: {
        id: "goose",
        label: "Goose",
        command: "goose",
        args: ["run", "-t", "{{prompt}}"],
        promptMode: "arg",
        resultMode: "stdout",
        modelArgs: ["--model", "{{model}}"],
        doctorArgs: ["--version"],
        usage: { estimate: true },
        experimental: true
    },
    copilot: {
        id: "copilot",
        label: "GitHub Copilot CLI",
        command: "copilot",
        args: ["-p", "{{prompt}}", "--allow-all-tools"],
        promptMode: "arg",
        resultMode: "stdout",
        modelArgs: ["--model", "{{model}}"],
        doctorArgs: ["--version"],
        usage: { estimate: true },
        experimental: true
    },
    "cursor-agent": {
        id: "cursor-agent",
        label: "Cursor Agent",
        command: "cursor-agent",
        args: ["-p", "{{prompt}}", "--force"],
        promptMode: "arg",
        resultMode: "stdout",
        modelArgs: ["--model", "{{model}}"],
        doctorArgs: ["--version"],
        usage: { estimate: true },
        experimental: true
    },
    qwen: {
        id: "qwen",
        label: "Qwen Code",
        command: "qwen",
        args: ["-p", "{{prompt}}", "--yolo", "--skip-trust"],
        promptMode: "arg",
        resultMode: "stdout",
        modelArgs: ["-m", "{{model}}"],
        doctorArgs: ["--version"],
        usage: { estimate: true },
        experimental: true
    },
    amp: {
        id: "amp",
        label: "Amp",
        command: "amp",
        args: ["-x", "{{prompt}}"],
        promptMode: "arg",
        resultMode: "stdout",
        modelArgs: ["--model", "{{model}}"],
        doctorArgs: ["--version"],
        usage: { estimate: true },
        experimental: true
    }
};
//# sourceMappingURL=specs.js.map