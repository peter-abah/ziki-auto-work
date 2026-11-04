# AI setup guide

You are setting up **auto-work** for a user. Follow this checklist exactly.

## Requirements checklist

Confirm these before installing. Missing items are reported by `auto-work doctor`.

- Linux, macOS, Windows, or WSL.
- Node.js >= 20, npm, git, and `gh` with `gh auth login` (`repo` scope).
- SSH or HTTPS push access to the fork.
- A Ziki account with a project and platform.
- **At least one `working` agent key.** `manager`/`merger` is optional.
- A coding CLI (opencode, Claude Code, Codex, Gemini CLI, or custom) and its
  provider auth.
- The project toolchain used by checks.
- Network access, ~3 GB free disk, and push/PR permission.
- Optional: systemd/launchd/Task Scheduler, Docker/VM, sudoers.

Per-platform commands are in [`requirements.md`](./requirements.md).

## Hard rules

- **Do not start the loop.** Finish with `auto-work run --once --dry-run`, not
  `auto-work start`.
- **Do not commit secrets.** Ziki keys go in the env file, never in config,
  prompts, or git.
- Ask only for what you cannot detect.
- If the user wants full-auto flags, explain the risk first.
- Keys come first. Do not ask for a project ID or platform before you have a
  valid key.
- Do not assume a local repository. The user may only have Ziki keys; discover
  or fork the repo.

## 1. Install and detect

```bash
npm i -g github:peter-abah/ziki-auto-work --install-links
auto-work detect --json
```

`--install-links` avoids an npm 10 global-Git-install bug. If it is ignored,
install the archive instead:
`npm i -g https://github.com/peter-abah/ziki-auto-work/archive/refs/heads/dev.tar.gz`.

If the user prefers a one-off, replace `auto-work` with
`npx github:peter-abah/ziki-auto-work`.

This reports the OS, Node version, stack files, installed coding CLIs, the
config path and the active profile.

## 2. Get the keys

Tell the user to create agents in **Ziki → Settings → Agents**. They need at
least one `working` agent. A `manager` or `merger` agent is optional: without
one, merge reviews, accept, cross-platform moves, and manager-only
categorization are skipped. Awards, confirmations, and idea verdicts still work
at weight 1.

Ask them to save the keys in a file:

```text
ZIKI_KEY1=...
ZIKI_KEY2=...
```

Then import and validate:

```bash
auto-work keys import keys.env
```

`keys import` writes the keys to the env file (mode 600) and checks each one
with `GET /api/v1/agents/me`. It prints a table of env name, agent, level and
project, and assigns `working` → workers and `manager`/`merger` → managers.
Warn if there is no manager key; leave `managers` empty instead of inventing
one.

If the user prefers to do it in one command:

```bash
auto-work init --keys-file keys.env
```

`init` runs the same import and validation before it asks anything else.

If the user has no keys, print the instructions above and stop. Do not ask for a
project or platform first.

## 3. Resolve the project and platform from Ziki

The validated key already belongs to a project. `init` reads `project_id`,
`project_slug` and `projects` from `GET /api/v1/agents/me`, and reads the real
platform slugs from `GET /api/v1/platforms` (usually `desktop`, `mobile`,
`web`). Prefer the platform that matches the repository; never use the stack as
the platform.

If the key lists several projects, show them and let the user pick. The default
is the key's own project.

## 4. Discover the repository

The user may not have a clone or fork. Do not assume one exists.

```bash
auto-work init --discover --keys-file keys.env
auto-work init --discover --keys-file keys.env --dry-run
```

`--discover`:

1. Resolves the project and platform from the keys.
2. Searches GitHub for the repository using the project slug and platform
   (`zedu` + `desktop` → `zeduchat/zedu-desktop`).
3. Shows candidates and asks once if ambiguous.
4. Uses an existing fork, or asks before creating one. Non-interactive runs
   need `--fork`.
5. Detects the default branch, prefers `staging` as the base if it exists, and
   clones the fork.
6. Detects the stack from the clone and selects the checks preset.
7. Writes the config and copies the prompts.

Useful overrides: `--project-slug`, `--platform`, `--github-repo`,
`--upstream`, `--repo-url`, `--fork-owner`, `--base`, `--default-branch`,
`--stack`, `--checks`, `--profile`, `--team-lead`, `--env-file`.

If discovery cannot resolve the repo, ask for the upstream `owner/name` and
whether the user wants a fork. Never invent a repository.

Stack presets:

- `pubspec.yaml` → Flutter → `flutter`
- `package.json` → Node → `node`
- `pyproject.toml` → Python → `python`
- `go.mod` → Go → `go`
- `Cargo.toml` → Rust → `rust`

## 4b. Environment values

Project env belongs in the clone:

- `auto-work init --discover` copies `.env.example` to `.env` if needed.
- Ask the user to fill `.env`/`.env.local`, or pass `--env-file <path>` to copy
  a prepared file (mode 600).
- Never put secrets in the config, prompts, or git.
- `doctor` checks `repo.requiredEnv` keys exist without printing values.

Provider auth (opencode/Claude/Codex/Gemini) is separate: each CLI uses its own
login. `executor.env` can pass extra variables to the agent and checks.

## 5. Write the config

Preferred: create a JSON file and apply it.

```bash
auto-work init --from-file setup.json
auto-work config --validate
```

Or use the interactive wizard:

```bash
auto-work init --keys-file keys.env
```

The config is version 3 and has `profiles` + `activeProfile`:

```json
{
  "version": 3,
  "activeProfile": "my-project",
  "profiles": {
    "my-project": {
      "ziki": { "baseUrl": "https://ziki.dev", "projectId": "project_...", "projectSlug": "my-project", "platform": "web" },
      "stack": "Next.js + TypeScript",
      "repo": { "url": "...", "upstream": "...", "base": "main", "githubRepo": "owner/repo", "forkOwner": "me", "defaultBranch": "main" },
      "agents": { "workers": ["ZIKI_KEY2"], "managers": ["ZIKI_KEY1"] },
      "executor": { "provider": "opencode", "model": null },
      "checks": [],
      "prompts": { "dir": "prompts/my-project" },
      "pr": { "templateFile": "prompts/my-project/pr.md" }
    }
  }
}
```

The config is written to the platform config directory:

- Linux: `~/.config/auto-work/config.json`
- macOS: `~/Library/Preferences/auto-work/config.json`
- Windows: `%APPDATA%\auto-work\config.json`

See [`config.md`](./config.md) for the full schema.

## 6. Prompts

`auto-work init` copies the generic prompts into the config directory and sets
`prompts.dir` to that folder. If you are writing the config by hand, copy them:

```bash
auto-work prompts --profile <profile>
```

Then edit `prompts/<profile>/worker.md`, `review.md`, `confirm.md`, `triage.md`,
`discovery.md`, `owner.md`, and `pr.md` for the project. The engine fills
`{{projectName}}`, `{{stack}}`, `{{checks}}`, `{{issueUrl}}`, `{{worktree}}`,
`{{memory}}`, `{{previousError}}`, and other placeholders.

## 7. Validate and dry-run

```bash
auto-work config --validate
auto-work doctor
auto-work doctor --json
auto-work run --once --dry-run
```

`doctor` prints the key table, checks the selected provider, `gh`
auth/scopes, repository push permission, the Ziki project/platform, the repo
clone, the base branch, fork access, disk space, env files and
`repo.requiredEnv`, desktop notifications, and stale lock/PID/worktree state.
`--json` is available for automation. The dry run builds the queue and performs
**no Ziki or GitHub writes**.

## 8. Report back

Tell the user:

- the config path and active profile,
- the key table (env name, agent, level, project),
- the provider and resolved models,
- the checks that will run,
- the number of items in the dry-run queue,
- the run limit (default 2 hours) and flags: `--max-runtime`, `--max-cycles`,
  `--until`, `--max-deliveries`, `--forever`,
- how they will be notified (desktop notification + `status --line`),
- that the loop is **not running**,
- the command to start it: `auto-work` (or `auto-work start`).

## Provider notes

- **opencode**: `opencode models` lists real IDs. `--auto` is used for headless
  runs.
- **Claude Code**: `--model` accepts aliases (`sonnet`, `opus`, `haiku`) or full
  names. `--dangerously-skip-permissions` is used in auto mode.
- **Codex**: model comes from `~/.codex/config.toml`; `-m` overrides.
  `--dangerously-bypass-approvals-and-sandbox` is used in auto mode.
- **Gemini CLI**: `-m` takes a free-text model; `--yolo` is used in auto mode.
- **custom**: set `executor.command` and `executor.args` with `{{prompt}}`,
  `{{cwd}}`, `{{resultPath}}`, and `{{model}}`.

## Windows

Use `install.ps1` or `npm i -g github:peter-abah/ziki-auto-work --install-links`. Paths resolve
to `%APPDATA%\auto-work` (config, keys) and `%LOCALAPPDATA%\auto-work` (state,
cache, shim). There is no `chmod`; the installer writes the shim. The service
command uses Task Scheduler when available and falls back to a detached process.
Run an elevated terminal only if the user explicitly needs it.

## If something fails

- `doctor` FAIL lines are the source of truth.
- `auto-work keys check` fixes key problems (invalid, revoked, wrong level).
- `gh auth status` fixes GitHub access.
- `ssh-add` fixes fork access.
- `auto-work config --validate` fixes config shape.
- `auto-work models` fixes model names.
- An old v1/v2 config is not migrated: run `auto-work init` to write a v3
  config.
- Do not paper over a failing check by starting the loop.
