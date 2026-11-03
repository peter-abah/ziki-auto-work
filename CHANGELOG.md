# Changelog

## Unreleased

- Renamed **jobs** to **profiles** everywhere (config v3: `profiles` and
  `activeProfile`). There is no automatic migration from v1/v2; run
  `auto-work init` to write a v3 config.
- Key-first onboarding: `init --keys-file` imports `ZIKI_*` keys, validates each
  with `GET /api/v1/agents/me`, assigns working keys to workers and
  manager/merger keys to managers, and resolves the project from the keys.
- Ziki platform is read from `GET /api/v1/platforms`; `stack` is detected
  separately and used for prompts and check presets.
- New `auto-work keys import <file>` and `auto-work keys check`.
- `doctor` prints the key table and warns when no manager/merger key is present.
- New `auto-work uninstall` removes service entries, the command shim, config,
  state, cache and known legacy paths. Flags: `--dry-run`, `--keep-data`,
  `--yes`.
- README now opens with a short AI setup prompt; global install is the primary
  path and `npx` is the one-off alternative.
- Commands and flags use `--profile` / `auto-work profiles`; `--job` and
  `auto-work jobs` are gone.
- Working-only agents are supported. Manager/merger keys are optional; without
  them merge reviews and manager-only actions are skipped, awards fall back to
  self-award, and confirmations/idea verdicts run at weight 1.
- Run limits: `maxRuntimeMinutes` (default 120), `maxCycles`, `stopAt`,
  `maxDeliveriesTotal`; `--max-runtime`, `--max-cycles`, `--until`,
  `--max-deliveries`, `--forever`. `status` shows limit, elapsed, remaining and
  stop reason.
- Observability: `auto-work report [--since] [--json]`,
  `auto-work history [--limit]`, `status --verbose`, and `history.jsonl`.
- Parallel execution: `src/scheduler.ts` TaskPool (2 deliveries, 1 review,
  2 auxiliary, 1 discovery, 4 agents) with a state mutex and in-flight status.
- Kill hardening: stale agent PIDs and worktrees are cleaned on start, existing
  PRs are reconciled instead of re-running the worker, `stop` aborts in-flight
  tasks, and systemd uses `KillMode=control-group`.
- Audit fixes: unhandled auxiliary kinds are marked recent, idea verdicts retry
  at weight 1 on 422, Go/Rust presets, generic protected files, fork-aware PR
  lookup, launchd log directory, escalation links, and a sudoers placeholder.
- Requirements docs (`docs/requirements.md`), expanded `doctor` (project,
  platform, gh scopes, push permission, service manager, stale state), and
  `doctor --json`.
- No versioned releases: `package.json` is `0.0.0` and the changelog is
  unreleased.
