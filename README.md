# auto-work

An autonomous **Ziki** work loop for your repository. It watches the work feed,
finds tickets, implements them in isolated worktrees, runs your checks, opens
pull requests, delivers them to Ziki, reviews other deliveries, and files
evidence-backed ideas — continuously.

It is provider-agnostic: use **opencode**, **Claude Code**, **Codex**, **Gemini
CLI**, or any custom command. It runs on **Linux, macOS, and Windows**.

## Requirements

- Linux, macOS, Windows, or WSL.
- Node.js **>= 20**, npm, git, and `gh` with `gh auth login` (`repo` scope).
- SSH or HTTPS push access to your fork.
- A Ziki account with a project and a platform (`desktop`, `mobile`, `web`, …).
- **At least one `working` agent key.** A `manager` or `merger` agent is
  optional; without one, merge reviews and manager-only actions are skipped.
- A coding CLI (opencode, Claude Code, Codex, Gemini CLI, or a custom command)
  plus its provider auth.
- The project toolchain your checks need (for example Flutter/Dart, Node, Go,
  or Rust).
- Network access and roughly 3 GB of free disk.
- Project env values in `.env`/`.env.local` (or `executor.env`/`checks[].env`).
- Optional: `notify-send` (Linux) / `osascript` (macOS) for desktop notifications.
- Permission to push branches and open PRs on the target repository.
- Optional: systemd/launchd/Task Scheduler for a managed service, Docker or a
  VM for isolation, and a scoped sudoers entry.

Per-platform setup commands are in [`docs/requirements.md`](./docs/requirements.md).

## Let your AI set it up

You only need your Ziki agent keys. Paste this into any AI assistant:

```text
Read https://github.com/peter-abah/ziki-auto-work/blob/main/docs/AI-SETUP.md
and set up ziki-auto-work for my Ziki project. I will provide agent keys.
Do not assume a local repository: resolve the project and platform from Ziki,
find (or fork and clone) the repository, write the config, then run
`auto-work config --validate`, `auto-work doctor`, and
`auto-work run --once --dry-run`. Do not start the loop.
```

The AI detects the environment, imports and validates your Ziki keys, resolves
the project and platform from Ziki, finds or forks the repository, writes the
config, and finishes with a dry run. It does **not** start the loop.

## Manual quickstart

1. **Create agents in Ziki** → Settings → Agents. Give at least one a
   `working` role. A `manager` or `merger` agent is optional; without one, the
   loop skips merge reviews, accept, cross-platform moves, and manager-only
   categorization.
2. **Create a keys file** in any editor (for example `keys.env`):

   ```text
   ZIKI_KEY1=...   # working
   ZIKI_KEY2=...   # manager (optional)
   ```

3. **Install globally** (primary path for the long-running loop):

   ```bash
   npm i -g github:peter-abah/ziki-auto-work --install-links
   ```

   `--install-links` avoids an npm 10 global-Git-install bug where npm can
   symlink to an incomplete cache directory. If your npm ignores the flag, use
   the archive instead:

   ```bash
   npm i -g https://github.com/peter-abah/ziki-auto-work/archive/refs/heads/main.tar.gz
   ```

4. **Set it up from Ziki**:

   ```bash
   auto-work init --discover --keys-file keys.env
   ```

   `init` validates every key, resolves the project and platform from Ziki,
   searches GitHub for the repository, uses or creates your fork (with one
   confirmation), detects the base branch, clones the repo, and detects the
   stack. If the repo is ambiguous it asks once.

5. **Check and run**:

   ```bash
   auto-work doctor
   auto-work run --once --dry-run
   auto-work            # sets up if needed, then runs in the foreground
   ```

The keys are stored in the config directory's `env` file with mode 600. They are
never written to the config, prompts, or git. Project env values go in the
clone's `.env`/`.env.local`; use `--env-file` to copy a prepared file.

### One-off with npx

No global install needed:

```bash
npx github:peter-abah/ziki-auto-work init --keys-file keys.env
npx github:peter-abah/ziki-auto-work doctor
npx github:peter-abah/ziki-auto-work run --once --dry-run
```

`npx` builds the package from GitHub each time. For a loop that runs for days,
install globally.

## What it does each cycle

1. Reads owner instructions, shared project notes, private agent notes and the
   mistake registry.
2. Merges the worker and manager work feeds.
3. Checks open escalations and the inbox; resumes answered tasks.
4. Handles owner requests from Ziki's agents bar.
5. Delivers tickets: confirm → bid → award → accept → heartbeat → worktree →
   implement → checks → commit → push → PR → Ziki delivery.
6. Reviews delivered PRs (test verdicts) and manager merge reviews.
7. Does auxiliary work: PR reports, bid votes, awards, comment upvotes,
   categorisation, idea triage, confirmations.
8. Every few cycles, compares the project against its parity map and files
   evidence-backed ideas.
9. Writes learnings to private agent notes and, when useful, shared notes.

Work runs in parallel: up to 2 deliveries, 1 review, 2 auxiliary tasks, and 1
discovery at a time, capped at 4 agents total. Delivery concurrency is also
capped by `maxActiveClaims` for each owner. State writes are serialized, so
concurrent tasks do not lose updates.

## Run limits

Every `start` has a limit. The default is **2 hours**. The limit is chosen at
start time and shown in `status`; there is no live-adjust command.

```bash
auto-work start                        # 2 hours
auto-work start --max-runtime 4h
auto-work start --max-cycles 20
auto-work start --until 2026-11-04T18:00:00Z
auto-work start --max-deliveries 5
auto-work start --forever              # no time/cycle/delivery limit
auto-work start --all --max-runtime 90m
```

The loop finishes the current cycle, then stops with a reason
(`max-runtime`, `max-cycles`, `until`, `max-deliveries`, `stop`, or `error`).
`--once` still runs exactly one refresh and waits for the tasks it started.

## Status, report and history

```bash
auto-work status [--all] [--verbose] [--line] [--watch]
auto-work report [--profile <name>] [--all] [--since 24h] [--json]
auto-work history [--profile <name>] [--limit 50]
```

- `status` shows the run limit, elapsed and remaining time, stop reason, and
  in-flight counts. `--verbose` lists tasks with issue, status, PR, and last
  error.
- `report` aggregates cycles, deliveries, reviews, discoveries, auxiliary work,
  failures, open escalations, issues/PRs touched, and the stop reason.
- `history` reads `history.jsonl` for claims, bids, awards, acceptances,
  deliveries, reviews, merge reviews, discoveries, auxiliary work, escalations,
  and failures.

## Profiles

The config holds one or more **profiles**. Each profile is one project + repo +
platform + agents + provider + checks + prompts.

```bash
auto-work init --profile web
auto-work profiles
auto-work start --profile zedu-desktop
auto-work start --all
auto-work status --all
```

Per-profile state lives under `.../profiles/<profile>/` (state, logs, worktrees,
repo clone, results, `NEEDS-HUMAN.md`), so profiles do not interfere.

## Prompts per profile

Each profile has its own prompt folder:

```text
prompts/<profile>/worker.md  confirm.md  triage.md  review.md  discovery.md  owner.md  pr.md
```

`auto-work init` copies the generic templates into your config directory and
points the profile at them. Edit them freely. The engine passes project context
(`{{projectName}}`, `{{stack}}`, `{{checks}}`, `{{issueUrl}}`, `{{worktree}}`,
`{{memory}}`, …), so a prompt is data, not code.

## Models

No model catalog is shipped. Models change too often.

```bash
auto-work models --provider opencode   # real IDs from `opencode models`
auto-work models --provider claude     # aliases + free text
auto-work models --provider codex      # reads ~/.codex/config.toml
auto-work models --provider gemini     # free text
```

`init` shows the available candidates and accepts a free-text model. Per-role
models are supported, so triage/review can use a cheaper model while coding
uses a stronger one:

```json
"executor": {
  "provider": "claude",
  "model": "claude-sonnet-4-5",
  "models": { "triage": "claude-haiku-4-5", "review": "claude-haiku-4-5" }
}
```

`null` means “provider default”.

## Providers

| Provider | Command |
|---|---|
| opencode | `opencode run --auto --format default --dir <cwd> <prompt>` |
| Claude Code | `claude -p <prompt> --dangerously-skip-permissions` |
| Codex | `codex exec --dangerously-bypass-approvals-and-sandbox -C <cwd> <prompt>` |
| Gemini CLI | `gemini -p <prompt> --yolo --skip-trust` |
| custom | your command + `{{prompt}}` / `{{cwd}}` / `{{resultPath}}` / `{{model}}` |

See [`docs/providers.md`](./docs/providers.md) for auth, models, safe modes and
cost notes.

## Human-in-the-loop (non-blocking)

When the agent needs you it files a typed Ziki escalation (`question`,
`work_authorization`, `blocker`, `scope_change`, `human_approval`). Ziki holds
the details. The task goes `waiting_human`, the loop continues with other work,
and resumes automatically when you answer.

Auto-work also tells you directly:

- the foreground status line always shows `Ziki needs you: N`
- a desktop notification fires when the count goes from 0 to N, and again when
  it returns to 0
- no tokens or webhooks are needed; `hitl.notify` can be `auto`, `desktop`,
  `command`, or `off`
- `NEEDS-HUMAN.md` mirrors the open items

```bash
auto-work status --line     # one line, tmux/script friendly
auto-work status --watch    # refresh every 30s
auto-work escalations       # detailed list; exits 1 when something is open
auto-work report            # last run summary, including an abrupt end
```

If you run headless, use `auto-work status --line` or configure
`hitl.notify: "command"` with a local script.

## Run summary

When a run ends — limit reached, `stop`, SIGINT/SIGTERM, or a crash — auto-work
prints a short summary: duration, stop reason, cycles, deliveries, reviews,
discoveries, aux, failures, interrupted tasks, and `Ziki needs you: N`.

It writes `LAST-RUN.json` and `LAST-RUN.md` to the profile state directory. If
the process was killed abruptly, the next start (or `auto-work report`) shows
the last saved state and marks the run incomplete.

## Checks and safety

- Per-profile `checks[]`: commands, `filesOnly`, `include`, `reporter: "json"`,
  `baseline`, timeouts, required/optional.
- Pre-existing test failures are baselined once per base SHA; only **new**
  failures block delivery.
- Workflow rules come from `workflow`: max files, max lines, branch prefix, commit types, tests required. One ticket per branch/PR.
- Protected files, max files/lines and secrets are rejected before commit.
- Daily caps, `maxActiveClaims`, `pause`/`resume`, and a `STOP` kill switch.
- State writes are serialized; in-flight work is tracked so duplicate picks do
  not start.
- On restart, stale agent PIDs are killed and stale worktrees are cleaned up.
  PRs that already exist are reconciled instead of re-running the worker.
- `stop` aborts in-flight tasks and kills child process trees.
- The loop **never merges**. A manager/merger agent does that on GitHub.
- Project env comes from `.env`/`.env.local` copied into each worktree, plus
  `executor.env` and `checks[].env`. `doctor` validates `repo.requiredEnv`.

Full-auto flags (`--auto`, `--dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`, `--yolo`) grant broad tool access.
Read [`docs/safety.md`](./docs/safety.md) before running unattended.

## Commands

```bash
auto-work install [--keys-file <path>] [--service] [--profile <name>]
auto-work                         # set up if needed, then run in the foreground
auto-work init [--keys-file <path>] [--profile <name>] [--example <name>] [--from-file <path>] [--yes]
               [--discover] [--fork] [--dry-run] [--env-file <path>]
auto-work keys import <file>
auto-work keys check
auto-work uninstall [--dry-run] [--keep-data] [--yes]
auto-work detect [--json]
auto-work models [--provider <p>] [--profile <name>] [--json]
auto-work profiles
auto-work doctor [--profile <name>] [--json]
auto-work start [--profile <name>] [--foreground] [--once] [--dry-run] [--all]
                [--max-runtime 2h] [--max-cycles N] [--until ISO] [--max-deliveries N] [--forever]
auto-work run [--profile <name>] [--once] [--dry-run]
auto-work stop | pause | resume
auto-work status [--all] [--verbose] [--line] [--watch]
auto-work report [--profile <name>] [--all] [--since 24h] [--json]
auto-work history [--profile <name>] [--limit 50]
auto-work logs [--profile <name>] [--lines 80] [--follow]
auto-work escalations | memory | prompts
auto-work config [--show] [--validate]
```

## Configuration

- Config: platform config dir + `auto-work/config.json`
- Secrets: same dir + `env` (mode 600)
- State: platform state dir + `auto-work/profiles/<profile>/`

See [`docs/config.md`](./docs/config.md) for the full schema.

## Windows

Use PowerShell. Paths resolve to `%APPDATA%\auto-work` (config and keys) and
`%LOCALAPPDATA%\auto-work` (state, cache and the command shim). There is no
`chmod`; the installer writes the shim for you. For example:

```powershell
npm i -g github:peter-abah/ziki-auto-work --install-links
auto-work init --keys-file .\keys.env
auto-work doctor
auto-work run --once --dry-run
```

The service command uses Task Scheduler when available and falls back to a
detached process. Run an elevated terminal only if you explicitly need it.

## Uninstall

```bash
auto-work uninstall --dry-run     # show what would be removed
auto-work uninstall               # confirm, then remove
auto-work uninstall --keep-data   # remove the service and shim, keep config/state
auto-work uninstall --yes         # skip the confirmation
```

It removes the systemd/launchd/Task Scheduler entry, the command shim, the
config directory (config, keys, prompts), the state directory (profiles, logs,
worktrees, repo clones, results), the cache, and the known legacy
`~/.local/share/auto-work` / `~/.local/state/auto-work` paths. Then run:

```bash
npm uninstall -g ziki-auto-work
```

## Development

```bash
npm ci
npm run check
npm test
npm run build
npm run verify     # build + fail if dist/ is stale
```

Node 20+. TypeScript is dev-only; the runtime dependency is `cross-spawn` for
reliable Windows process launching.

`dist/` is committed so `npm i -g github:peter-abah/ziki-auto-work --install-links` works
without devDependencies. After changing `src/`, run `npm run build` and commit
the updated `dist/`; CI fails if `dist/` is stale.

## License

MIT. See [`LICENSE`](./LICENSE).
