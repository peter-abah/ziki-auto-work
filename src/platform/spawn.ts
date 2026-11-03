import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finish = (code: number, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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
      } catch {
        // already gone
      }
      finish(-1, new Error(`timed out after ${Math.round((options.timeoutMs ?? 120000) / 1000)}s`));
    }, options.timeoutMs ?? 120000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    child.on("error", (error) => finish(-1, error));
    child.on("close", (code) => finish(code ?? -1));
  });
}

export function spawnCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });
}

export function spawnDetached(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: "ignore",
    detached: true
  });
  child.unref();
  return child;
}
