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
- `init --discover` for Ziki-first setup: project/platform from keys, GitHub
  repo search, fork detection/creation, branch detection, clone and stack
  detection. `--dry-run` is read-only.
- Config-driven `workflow` rules (max files/lines, branch prefix, commit types,
  tests required) injected into prompts and enforced by the orchestrator.
  Protected files, PR target/head, team lead and the PR template are surfaced
  to the agent.
- `executor.env` is applied to agents and checks; toolchain directories are
  prepended to `PATH`; `repo.envFiles` and `repo.requiredEnv` are supported.
- Env/tool/auth failures are classified as blockers instead of silent retries;
  escalation-cap and waiting-claim handling fixed.
- `needsYou` status summary, `status --line`, `status --watch`, and zero-config
  desktop notifications on count changes.
- Plain `auto-work` sets up if needed, starts in the foreground, or shows status
  when a loop is already running.
- Clean and abrupt run summaries: `LAST-RUN.json`, `LAST-RUN.md`, and
  `auto-work report` defaulting to the last run.
- Packaging: `dist/` is committed and `prepare` is removed, so
  `npm i -g github:peter-abah/ziki-auto-work --install-links` no longer needs devDependencies.
  `prepack` still builds for publishing, and CI checks that `dist/` is current.
