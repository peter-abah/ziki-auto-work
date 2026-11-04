import type { HitlConfig, NotifyMode, ProfileConfig } from "./types.js";
import type { Logger } from "./log.js";
import { runCommand } from "./platform/spawn.js";

export interface NotifyResult {
  ok: boolean;
  mode: NotifyMode;
  detail: string;
}

export function resolveNotifyMode(profile: ProfileConfig): NotifyMode {
  const mode = profile.hitl.notify;
  if (mode && ["auto", "desktop", "command", "off"].includes(mode)) return mode;
  return "auto";
}

function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsToastScript(title: string, body: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$title = ${psQuote(title)}`,
    `$body = ${psQuote(body)}`,
    "if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {",
    "  New-BurntToastNotification -Text $title, $body",
    "  exit 0",
    "}",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    "$n.ShowBalloonTip(10000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)",
    "Start-Sleep -Milliseconds 1200",
    "$n.Dispose()"
  ].join("\n");
}

export function desktopNotifier(platform = process.platform): { command: string; args: (title: string, body: string) => string[] } | null {
  if (platform === "linux") {
    return { command: "notify-send", args: (title, body) => ["-a", "auto-work", title, body] };
  }
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: (title, body) =>
        ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell",
      args: (title, body) => ["-NoProfile", "-NonInteractive", "-Command", windowsToastScript(title, body)]
    };
  }
  return null;
}

export async function desktopNotifierAvailable(platform = process.platform): Promise<boolean> {
  const notifier = desktopNotifier(platform);
  if (!notifier) return false;
  const check =
    platform === "win32"
      ? await runCommand("where", [notifier.command], { timeoutMs: 10_000 })
      : await runCommand("/bin/sh", ["-c", `command -v ${notifier.command}`], { timeoutMs: 10_000 });
  return check.ok;
}

async function notifyCommand(hitl: HitlConfig, title: string, body: string): Promise<NotifyResult> {
  if (!hitl.notifyCommand) return { ok: false, mode: "command", detail: "notifyCommand is not set" };
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", hitl.notifyCommand] : ["-c", hitl.notifyCommand];
  const result = await runCommand(shell, args, {
    env: { AW_TITLE: title, AW_BODY: body },
    timeoutMs: 15_000
  });
  return {
    ok: result.ok,
    mode: "command",
    detail: result.ok ? "sent via notifyCommand" : result.stderr || result.stdout || "notifyCommand failed"
  };
}

async function notifyDesktop(title: string, body: string): Promise<NotifyResult> {
  const notifier = desktopNotifier();
  if (!notifier) return { ok: false, mode: "desktop", detail: `no desktop notifier for ${process.platform}` };
  const result = await runCommand(notifier.command, notifier.args(title, body), { timeoutMs: 10_000 });
  return {
    ok: result.ok,
    mode: "desktop",
    detail: result.ok ? `sent via ${notifier.command}` : result.stderr || result.stdout || `${notifier.command} failed`
  };
}

export async function notifyProfile(
  profile: ProfileConfig,
  title: string,
  body: string,
  logger?: Logger | null
): Promise<NotifyResult> {
  const mode = resolveNotifyMode(profile);
  if (mode === "off") return { ok: true, mode, detail: "notifications disabled" };

  let result: NotifyResult;
  if (mode === "command") {
    result = await notifyCommand(profile.hitl, title, body);
  } else if (mode === "desktop") {
    result = await notifyDesktop(title, body);
  } else {
    result = await notifyDesktop(title, body);
    if (!result.ok) {
      result = await notifyCommand(profile.hitl, title, body);
      if (!result.ok) result = { ok: false, mode: "auto", detail: "no desktop notifier and no notifyCommand" };
    }
  }

  if (!result.ok) logger?.warn(`Notification failed: ${result.detail}`);
  else logger?.info(`Notification sent (${result.mode}): ${title}`);
  return result;
}
