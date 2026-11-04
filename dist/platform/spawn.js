import spawn from "cross-spawn";
export function runCommand(command, args, options = {}) {
    const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer;
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            stdio: ["ignore", "pipe", "pipe"]
        });
        const finish = (code, error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve({
                ok: code === 0 && !error,
                code,
                stdout,
                stderr: error ? `${stderr}\n${error.message}` : stderr,
                command: `${command} ${args.join(" ")}`
            });
        };
        timer = setTimeout(() => {
            try {
                child.kill("SIGTERM");
            }
            catch {
                // already gone
            }
            finish(-1, new Error(`timed out after ${Math.round((options.timeoutMs ?? 120000) / 1000)}s`));
        }, options.timeoutMs ?? 120000);
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > maxBuffer)
                stdout = stdout.slice(-maxBuffer);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > maxBuffer)
                stderr = stderr.slice(-maxBuffer);
        });
        child.on("error", (error) => finish(-1, error));
        child.on("close", (code) => finish(code ?? -1));
    });
}
export function spawnCommand(command, args, options = {}) {
    return spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
    });
}
export function spawnDetached(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: "ignore",
        detached: true
    });
    child.unref();
    return child;
}
//# sourceMappingURL=spawn.js.map