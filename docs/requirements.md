# Requirements

auto-work runs a coding agent continuously and pushes branches, so set it up on
a machine you are comfortable leaving running. Anything missing from this list
shows up in `auto-work doctor`.

## Checklist

- Linux, macOS, Windows, or WSL.
- Node.js **>= 20** and npm.
- git, plus SSH or HTTPS push access to your fork.
- `gh` (GitHub CLI) authenticated with at least the `repo` scope.
- A Ziki account, project, and platform slug. No local repo or fork is
  required up front; `init --discover` finds or creates them.
- **At least one `working` agent key.** `manager`/`merger` keys are optional.
- A coding CLI with provider auth: opencode, Claude Code, Codex, Gemini CLI, or a
  custom command.
- The project toolchain used by checks (Flutter/Dart, Node, Go, Rust, Python, …).
- Network access and roughly 3 GB of free disk.
- Push and PR permission on the target repository (or permission to fork it).
- Project env values in `.env`/`.env.local`, or `executor.env`/`checks[].env`.
- Optional: `notify-send`/`osascript` for desktop notifications.
- Optional: systemd/launchd/Task Scheduler, Docker or a VM, sudoers.

## Linux

```bash
# Node 20+ (NodeSource example; nvm works too)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git libnotify-bin
gh auth login

# Provider (pick one)
npm i -g opencode-ai        # opencode
npm i -g @anthropic-ai/claude-code
npm i -g @openai/codex
npm i -g @google/gemini-cli
```

Optional service:

```bash
auto-work install --service
systemctl --user daemon-reload
systemctl --user enable --now auto-work-<profile>.service
```

## macOS

```bash
brew install node git gh
gh auth login
# desktop notifications use the built-in osascript
npm i -g github:peter-abah/ziki-auto-work
```

Optional launchd service: `auto-work install --service` writes
`~/Library/LaunchAgents/io.autowork.<profile>.plist`.

## Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS Git.Git GitHub.cli
gh auth login
npm i -g github:peter-abah/ziki-auto-work
```

Paths resolve to `%APPDATA%\auto-work` (config and keys) and
`%LOCALAPPDATA%\auto-work` (state, cache, shim). There is no `chmod`; the
installer writes the shim. The service uses Task Scheduler when available and
falls back to a detached process.

## WSL

Install inside WSL, not on the Windows side, so paths and process signals work
normally. Keep the repository inside the Linux filesystem (for example
`~/code/...`), not under `/mnt/c`.

## Verify

```bash
auto-work doctor
auto-work run --once --dry-run
```

`doctor` checks Node, config, keys, provider, git, `gh` auth/scopes, repository
push permission, Ziki project/platform, disk space, and stale lock/PID/worktree
state. Fix the `FAIL` lines before starting the loop.
