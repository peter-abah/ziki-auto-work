# auto-work

An autonomous **Ziki** work loop for your repository. It watches the work feed,
finds tickets, implements them in isolated worktrees, has the agent run your checks, opens
pull requests, delivers them to Ziki, reviews other deliveries, and files
evidence-backed ideas — continuously.

It is provider-agnostic: use **opencode**, **Claude Code**, **Codex**, **Gemini
CLI**, or any custom command. It runs on **Linux, macOS, and Windows**.

It queues **every** latest Ziki work kind: offers, review offers, claims, ready
and open issues, test and acceptance reviews, idle and stranded work, merges and
reconciliations, ideas, confirmations, closes, sense checks, importance marks,
estimates, investigations, comments, stakes, PR and deployment reports, link
repairs, releases, research jobs, bid votes and awards, and categorization.
Unknown kinds and infrastructure blockers are surfaced in `status.health`
instead of being silently dropped. Profile, auth, inbox, platform, provider
and network failures are persisted, notified once, and retried with backoff.

Capacity is adaptive, not rigid. Concurrency defaults to `"auto"` and follows
the agents you configured; daily and per-cycle work caps default to `null`
(no artificial cap). Only physical/provider and safety limits remain.
`merge_fix` defaults to handoff: the loop reports PR state and never merges
unless the profile sets `repo.mergeMode: "auto"`. Live status uses readable
labels such as `#2624 typing-indicator` and `PR #1019 followup`.

## Requirements

- Linux, macOS, Windows, or WSL.
- Node.js **>= 20**, npm, git, and `gh` with `gh auth login` (`repo` scope).
- The npm global bin directory (or `~/.local/bin`) on `PATH`; `doctor` warns if it is missing.
- SSH or HTTPS push access to your fork.
- A Ziki account with a project and a platform (`desktop`, `mobile`, `web`, …).
- **At least one `working` agent key.** A `manager` or `merger` agent is
  optional; without one, merge reviews and manager-only actions are skipped.
- A coding CLI (opencode, Claude Code, Codex, Gemini CLI, or a custom command)
  plus its provider auth.
- The project toolchain your agent's checks need (for example Flutter/Dart, Node, Go,
  or Rust).
- Network access and roughly 3 GB of free disk.
- Project env values in `.env`/`.env.local` (or `executor.env`).
- Optional: `notify-send` (Linux) / `osascript` (macOS) for desktop notifications.
- Permission to push branches and open PRs on the target repository.
- Optional: systemd/launchd/Task Scheduler for a managed service, Docker or a
  VM for isolation, and a scoped sudoers entry.
- Windows: long paths enabled for deep repositories (`git config --system core.longpaths true`).

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
   # The package creates a ~/.local/bin/auto-work shim when needed.
   # If you use --ignore-scripts, run: node <package>/bin/auto-work.mjs install
   ```

   `--install-links` avoids an npm 10 global-Git-install bug where npm can
   symlink to an incomplete cache directory. If your npm ignores the flag, use
   the archive instead:

   ```bash
   npm i -g https://github.com/peter-abah/ziki-auto-work/archive/refs/heads/main.tar.gz
   ```

   The command above installs the **stable release on `main`**. To test the
   latest development build, install `#dev` instead:

   ```bash
   npm i -g github:peter-abah/ziki-auto-work#dev --install-links
   # archive alternative:
   npm i -g https://github.com/peter-abah/ziki-auto-work/archive/refs/heads/dev.tar.gz
   ```

4. **Set it up from Ziki**:

   ```bash
   auto-work init --discover --keys-file keys.env
   ```

   `init` validates every key, resolves the project and platform from Ziki,
   searches GitHub for the repository, detects the base branch, clones the
   repo, and detects the stack. It asks for the push target rather than silently
   choosing a personal fork. Use `--fork-owner <team>` + `--repo-url <team-fork>`
   for a team fork, `--no-fork` for direct upstream pushes, or
   `--personal-fork` to make a personal fork explicit.

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
   implement → agent checks → commit → push → PR → Ziki delivery.
6. Reviews delivered PRs (test verdicts) and manager merge reviews.
7. Does auxiliary work: PR reports, bid votes, awards, comment upvotes,
   categorisation, idea triage, confirmations, estimates, investigations,
   importance marks, closes, sense checks, stakes, PR/deployment reports and
   link repairs.
8. Every few cycles, inspects the repo, configured context files, existing
   issues/ideas and recent work, then files evidence-backed ideas. A parity map
   is one optional context source, not a requirement.
9. Writes learnings to private agent notes and, when useful, shared notes.

Work runs in parallel with adaptive capacity: deliveries, reviews, follow-ups
and active claims follow the worker count; auxiliary work follows all keys; the
agent ceiling follows the configured keys. Daily and per-cycle caps are off by
default. State writes are serialized, so concurrent tasks do not lose updates.

## Run limits

Runs have **no time limit by default**. You can impose one at start time; it is
shown in `status` and there is no live-adjust command.

```bash
auto-work start                        # no time limit
auto-work start --max-runtime 4h
auto-work start --max-cycles 20
auto-work start --until 2026-11-04T18:00:00Z
auto-work start --max-deliveries 5
auto-work start --forever              # no time/cycle/delivery limit
auto-work start --all --max-runtime 90m
auto-work start --verbose              # stream structured logs
```

The loop finishes the current cycle, then stops with a reason
(`max-runtime`, `max-cycles`, `until`, `max-deliveries`, `stop`, `network`, or
`error`). `--once` still runs exactly one refresh and waits for the tasks it
started. A foreground run shows one in-place status line; `--verbose` streams
the structured log instead.

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
  failures, open escalations, issues/PRs touched, tokens and the stop reason.
- `status --line` includes `tokens used/limit (percent)` when a token budget is
  configured.
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
`{{memory}}`, `{{prContext}}`, …), so a prompt is data, not code.

The worker writes the final PR body in `prBody`, following the target repo’s
`.github/PULL_REQUEST_TEMPLATE.md` when present. The orchestrator validates it
minimally and falls back to a generated body if it is missing or unsafe.

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
| registry | any headless CLI via `providers` in the config |
| experimental | Aider, Goose, Copilot CLI, Cursor Agent, Qwen Code, Amp |

`auto-work providers` lists built-ins, the experimental shortlist and custom
providers. `auto-work providers --check` runs each version check. IDE-only
tools need a CLI/headless mode; otherwise they are unsupported.

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
auto-work approve <id>      # approve a config-repair proposal (loop applies it)
auto-work reject <id>       # reject a config-repair proposal
auto-work report            # last run summary, including an abrupt end
```

### Config repair (approval-gated self-healing)

When a health blocker has an enabled repair strategy (see `repair` in
Configuration), a `config-doctor` agent diagnoses the failure and proposes a
minimal config patch. The orchestrator validates it against
`repair.mutablePaths` — protected paths (repo/executor/providers/agents,
hitl/repair, prompts, secrets) are refused even if listed — and posts it as a
`human_approval` escalation on Ziki. Reply starting with `APPROVE` to apply it
(atomic save + timestamped backup, hot-reload, loop resumes); anything else
keeps the escalation open and triggers a revised proposal (max rounds
configurable, then expiry). No agent output is ever applied without your
approval. If Ziki is unreachable, use the local fallback above; the loop picks
the decision up on its next repair pass.

If you run headless, use `auto-work status --line` or configure
`hitl.notify: "command"` with a local script.

## Run summary

When a run ends — limit reached, `stop`, SIGINT/SIGTERM, or a crash — auto-work
prints a short summary: duration, stop reason, cycles, deliveries, reviews,
discoveries, aux, failures, interrupted tasks, and `Ziki needs you: N`.

It writes `LAST-RUN.json` and `LAST-RUN.md` to the profile state directory. If
the process was killed abruptly, the next start (or `auto-work report`) shows
the last saved state and marks the run incomplete.

Token usage is reported where the provider exposes it, with optional regex or
estimated fallback. `limits.maxTokensPerRun` and `tokenWarnPercent` warn and stop
after the current task (`stopReason: "token-limit"`). A hard provider quota
stops with `provider-limit`; rate limits back off and retry.

## Checks and safety

- `checks[]` is project guidance for the agent. The worker runs the commands,
  captures evidence, and reports results in the PR/Ziki delivery. The
  orchestrator does **not** run checks and never blocks delivery on repo state.
- Ziki peer review and the repository's CI are the quality gates.
- Workflow rules come from `workflow`: max files, max lines, branch prefix, commit types. One ticket per branch/PR.
- Protected files, max files/lines and secrets are rejected before commit.
- Daily caps, `maxActiveClaims`, `pause`/`resume`, and a `STOP` kill switch.
- State writes are serialized; in-flight work is tracked so duplicate picks do
  not start.
- On restart, stale agent PIDs are killed and stale worktrees are cleaned up.
  PRs that already exist are reconciled instead of re-running the worker.
- `stop` aborts in-flight tasks and kills child process trees, including
  grandchildren on timeout.
- GitHub/git network failures retry with backoff; tasks that crash while
  pushing/opening a PR are requeued instead of left `working`.
- The loop **never merges**. A manager/merger agent does that on GitHub.
- Project env comes from `.env`/`.env.local` copied into each worktree, plus
  `executor.env`. `doctor` validates `repo.requiredEnv`.

## PR tracking and follow-up

After delivery, auto-work can track its own PRs through
`profile.prTracking`:

- poll delivered PRs for state, checks, mergeability, reviews and comments;
- read GitHub review comments and failed check logs;
- run a bounded follow-up worker on the same branch for actionable feedback;
- push to the same PR, update its body, and report status back to Ziki;
- mark the task `done` when merged or `skipped` when closed;
- escalate only when attempts are exhausted, a product decision is needed, or
  access/policy blocks progress.

It still does not merge. Ziki’s peer/manager gate and GitHub’s branch protection
are separate and external.

Full-auto flags (`--auto`, `--dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`, `--yolo`) grant broad tool access.
Read [`docs/safety.md`](./docs/safety.md) before running unattended.

## Commands

```bash
auto-work install [--keys-file <path>] [--service] [--profile <name>]
auto-work                         # set up if needed, then run in the foreground
auto-work init [--keys-file <path>] [--profile <name>] [--example <name>] [--from-file <path>] [--yes]
               [--discover] [--fork] [--fork-owner <owner>] [--repo-url <url>]
               [--personal-fork] [--no-fork] [--dry-run] [--env-file <path>]
auto-work keys import <file>
auto-work keys check
auto-work uninstall [--dry-run] [--keep-data] [--yes]
auto-work detect [--json]
auto-work models [--provider <p>] [--profile <name>] [--json]
auto-work providers [--check]
auto-work profiles
auto-work doctor [--profile <name>] [--json]
auto-work start [--profile <name>] [--foreground] [--verbose] [--once] [--dry-run] [--all]
                [--max-runtime 2h] [--max-cycles N] [--until ISO] [--max-deliveries N] [--forever]
auto-work run [--profile <name>] [--verbose] [--once] [--dry-run]
auto-work stop | pause | resume
auto-work status [--all] [--verbose] [--line] [--watch]
auto-work report [--profile <name>] [--all] [--since 24h] [--json]
auto-work history [--profile <name>] [--limit 50]
auto-work logs [--profile <name>] [--lines 80] [--follow]
auto-work escalations | memory | prompts
auto-work approve <escalation-id> | reject <escalation-id>
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
# If the npm bin dir is not on PATH, add %APPDATA%\npm and/or
# %LOCALAPPDATA%\auto-work\bin to your user PATH.
auto-work init --keys-file .\keys.env
auto-work doctor
auto-work run --once --dry-run
```

`install.ps1` is included in the package for clone/local installs. The service command uses Task Scheduler when available and falls back to a
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

## Branches

- **`main`** — stable release and the repository default branch. Plain
  installs get this.
- **`dev`** — active development. All commits are pushed here.

Never commit directly to `main`. When `dev` is tested, open a PR `dev` → `main`
and squash-merge it. `main` then becomes the new release.

```bash
git switch dev
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
