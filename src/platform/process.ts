import { spawn as nodeSpawn } from "node:child_process";

export function windowsKillCommand(pid: number): { command: string; args: string[] } {
  return { command: "taskkill", args: ["/T", "/F", "/PID", String(pid)] };
}

export function killProcessTree(pid: number | null | undefined, platform = process.platform): void {
  if (!pid) return;
  if (platform === "win32") {
    try {
      const { command, args } = windowsKillCommand(pid);
      const child = nodeSpawn(command, args, { stdio: "ignore", detached: true });
      child.unref();
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 3000);
  timer.unref?.();
}
