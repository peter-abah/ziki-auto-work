# Changelog

## Unreleased

- The config-doctor now always sees Ziki's live `llms.txt` API docs: fetched
  once per run (in-memory cache, honest "unavailable" line on failure) and
  appended to every round's evidence, whatever the failure. Well-typed new
  keys under `ziki.endpoints.*` / `operations.*` pass patch validation so
  the doctor can propose llms-documented routes — still APPROVE-gated,
  live-verified before escalation, and read-back verified on apply. The
  agent acting alone still cannot invent routes.

- Fixed multi-op config patches persisting only the last op per section
  (`applyConfigPatch` re-resolves its target every iteration), and added
  read-back verification: the persisted config is re-read and every op path
  compared before reporting success, `NEEDS-HUMAN.md` is stat-checked after
  every escalation write, and backup paths are only reported when the copy
  exists.
- Repair rejections and exhausted proposal rounds now park at a visible
  dead-end (`config:repair_dead_end` warning + NEEDS-HUMAN entry) instead of
  silently re-proposing; a config edit starts a fresh episode and a
  successful repair clears it. New repair strategies `feed:not_found` and
  `*:not_found` route every 404 through project-rotation diagnosis, and
  repair-escalation RPC failures retry bounded by `maxRounds` before
  parking.
- State persistence failures now park the loop (`state:persist` blocked)
  instead of being swallowed; `loadState` rejects unknown schema versions;
  repeated cycle exceptions surface as `loop:cycle_error` (blocked at
  `health.cycleErrorLimit`, default 5); malformed run-limits files fail
  loud; any blocked state without a strategy parks instead of dispatching.
- Dropped outbox entries and expired escalations now appear in NEEDS-HUMAN.md
  and `status`; non-open escalations are pruned to the latest 3 per group;
  `notifyNeedsYou` fires on content change; empty platform sets raise a
  visible warning; a mid-run `gh auth` check warns then parks; consecutive
  agent start/timeout failures escalate once at the limit; the agent log
  stream degrades to the in-memory tail on write failure; approval-queue
  consume is mutex-guarded; startup reconciles recorded claims with one
  heartbeat each.
- `findOpenPr` treats non-JSON output as unknown instead of throwing, and
  merge follow-up records "merged" and "reported to Ziki" as separate
  history facts.

- Added an adaptive Ziki API layer. Validation failures now strip unknown or
  rejected fields, repair oversized values, cache the learned contract per
  endpoint, and retry. Full Ziki error details are logged instead of the opaque
  `Invalid input.` message.
- If deterministic repair cannot fix a `400`/`422`, an `apiRepair` agent gets
  the operation, attempted payload and error body, and may return a corrected
  payload or abandon the action with a reason.
- Discovery now uses the live minimal create-idea payload (no unsupported
  `platform` field) and sanitizes idea summaries to plain 20–300 character text.
- Added tests for contract keys, unknown-field stripping, truncation, repair
  callbacks, the minimal idea payload, and summary sanitization.

- Failed work now releases its Ziki claim before being requeued or marked failed.
  Previously a retryable failure (notably “agent made no changes”) kept the
  claim, counted against `maxActiveClaims`, and could leave the loop idle with
  no dispatchable work.
- PR follow-up stops and marks the task skipped when Ziki returns `404` for the
  issue, instead of retrying `Issue not found` forever.
- Discovery now uses the current run’s cycle count in both the dispatcher and
  `discoveryPass`, so its cadence works correctly after a restart.
- Removed the daily delivery/review/discovery caps and the per-cycle auxiliary
  cap from the config schema and dispatcher. There are no daily work caps.
- Runs have no time limit by default; `--max-runtime`/`maxRuntimeMinutes` are
  still available when a limit is wanted.
- `maxAttemptsPerTask` and `maxOpenEscalations` now accept `null` for unlimited
  and default to `null`; the init template and examples no longer reintroduce
  the old caps.
- Removed the daily delivery/review/discovery caps and the per-cycle auxiliary
  cap from the config schema and dispatcher. There are no daily work caps.
- Runs have no time limit by default; `--max-runtime`/`maxRuntimeMinutes` are
  still available when a limit is wanted.
- `maxAttemptsPerTask` and `maxOpenEscalations` now accept `null` for unlimited
  and default to `null`; the init template and examples no longer reintroduce
  the old caps.
- Run limits: `--max-cycles` now counts cycles in the current run instead of
  using the lifetime cycle total. `status`, `report` and `LAST-RUN` show the
  run cycle count alongside the lifetime total, and discovery cadence resets
  with each run.
- Scheduling: auxiliary work now rotates by kind instead of letting a large
  investigation queue starve comments, bids and awards. Discovery reserves an
  agent slot when due, before auxiliary dispatch.
- Reviews now preflight the PR and existing verdicts: merged/closed PRs,
  failing or pending checks, conflicts and already-satisfied verdict counts
  are skipped before a review agent starts.
- Idempotent work handling: `open_issue`, `reclaim_issue`, idle reclaims and
  late review verdicts treat Ziki's "already done / not applicable" responses
  as no-ops instead of failures. `convertIdea` now sends a valid JSON body.
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
- Branch policy: `dev` is the development/push branch; `main` is release-only
  and the repository default. Do not commit to `main`; promote tested work with
  a `dev` → `main` squash PR.
- Provider registry: config-defined provider specs, `resultMode: "file"|"stdout"`,
  experimental shortlist (Aider, Goose, Copilot CLI, Cursor Agent, Qwen Code,
  Amp), and `auto-work providers [--check]`.
- Token tracking: provider JSON/JSONL usage parsing, regex/estimate fallback,
  `maxTokensPerRun`/`tokenWarnPercent`, token fields in status/report/LAST-RUN.
- Provider limits: hard quota stops with `provider-limit`; 429/rate limits back
  off and retry; context-window overflow escalates the task.
- Audit fixes: host-aware `gh` git protocol, packaged `install.ps1`/`install.sh`,
  PATH diagnostics, macOS launchd `PATH`, Windows toast notifications,
  `taskkill /T /F` process-tree shutdown, Windows `core.longpaths`, and a
  `pretest` that skips the build in an installed package.
- Packaging: `dist/` is committed and `prepare` is removed, so
  `npm i -g github:peter-abah/ziki-auto-work --install-links` no longer needs devDependencies.
  `prepack` still builds for publishing, and CI checks that `dist/` is current.
