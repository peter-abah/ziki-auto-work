# Architecture

```
src/
  cli.ts             commands, init wizard, detect, models, keys, uninstall
  config.ts          config v3, defaults, validation, env
  keys.ts            key import, validation and role assignment
  types.ts           shared types
  orchestrator.ts    the loop, dispatch and state machine
  scheduler.ts       TaskPool with per-kind and total concurrency limits
  mutex.ts           serialized state/history writes
  discover.ts        Ziki-first repo/fork/branch/stack discovery
  rules.ts           workflow/protected-file/PR-template prompt context
  env.ts             executor/check env and toolchain PATH
  notify.ts          desktop/command notifications
  run-report.ts      clean/abrupt run summaries
  ziki.ts            typed Ziki API client
  queue.ts           work-feed prioritisation and platform matching
  memory.ts          instructions, project notes, private notes, mistakes
  hitl.ts            escalations, inbox, non-blocking resume
  github.ts          clone, worktrees, push, PRs, PR status
  worktree.ts        per-ticket and review worktrees
  agent.ts           provider-agnostic executor + result contract
  providers/         opencode, claude, codex, gemini, custom
  checks.ts          generic check runner, baseline, secrets, protected files
  doctor.ts          environment validation
  service.ts         systemd/launchd/Task Scheduler/detached process
  uninstall.ts       service, shim, config and state cleanup
  platform/          paths, spawn, platform detection
  log.ts             structured logs
  state.ts           per-profile state, locks, pause/stop
```

## The cycle

1. `poll` — read open escalations and the inbox; resume answered tasks.
2. `memory` — refresh instructions, shared notes, private notes, mistakes.
3. `feed` — merge worker and manager work feeds with ETags.
4. `platform` — refresh the platform's issues and ideas (10 min cache).
5. `queue` — filter to this profile's platform, prioritise, skip recent/blocked.
6. `heartbeat` — keep active claims alive.
7. `baseline` — once per base SHA, record pre-existing check failures.
8. `owner` — handle one owner request.
9. `dispatch` — start work in parallel: deliveries, reviews, auxiliary tasks
   and discovery, subject to per-kind limits and `maxConcurrentAgents`.
   `inFlightKeys` prevents duplicate picks.
10. `delivery` — confirm/bid/award/accept, implement, check, push, PR, deliver.
11. `review` — test verdicts and manager merge reviews.
12. `aux` — PR reports, bid votes, awards, comment upvotes, categorisation,
    idea triage, confirmations.
13. `discovery` — every N cycles, file evidence-backed ideas.
14. `cleanup` — remove old worktrees.
15. save state, then sleep or wait for an in-flight task.

## Roles

A profile needs at least one working agent. Managers/mergers are optional; when
absent, merge reviews and manager-only actions are skipped, awards fall back to a
worker (self-award), and confirmations/idea verdicts run at weight 1. If no
worker exists, manager keys perform working tasks.

## Run limits and concurrency

`maxRuntimeMinutes` (default 120), `maxCycles`, `stopAt`,
`maxDeliveriesTotal`, or an explicit stop ends the loop after the current
cycle. Limits are chosen at `start` and recorded in `status.json` with elapsed
and remaining time and a stop reason. Concurrency defaults to 2 deliveries,
1 review, 2 auxiliary tasks, 1 discovery, and 4 agents total; delivery
concurrency is also capped by `maxActiveClaims`.

## Discovery and rules

`init --discover` resolves the project/platform from the keys, searches GitHub
for the repository, uses or creates a fork, detects branches, clones, and
detects the stack. Workflow rules live in `profile.workflow`; prompts receive
the resolved rules, protected files, PR target/head, team lead and PR template
via placeholders, and the orchestrator enforces file/line limits.

## Env

Worktrees receive the configured `repo.envFiles` (`.env`, `.env.local` by
default). Agents inherit the process env, then `executor.env`, then provider
and per-run env. Checks merge `executor.env` and `checks[].env`. Toolchain
directories are prepended to `PATH`. Env/auth/tool failures are classified as
blockers instead of silent retries.

## Notifications and run summary

Open escalations are summarized as `needsYou` in `status.json`. The status line
shows `Ziki needs you: N`; desktop notifications fire on count changes. Each
run builds a `RunSummary`, updated on every save, written to `LAST-RUN.json` /
`LAST-RUN.md` and printed on clean exit. Unclean runs are detected on the next
start or by `auto-work report`.

## State and history

All `state.json` and `status.json` writes go through a mutex, so concurrent
tasks do not lose updates. `history.jsonl` records claim/bid/award/accept,
delivery, review, merge review, discovery, auxiliary work, escalation, failure
and stop entries for `auto-work report` and `auto-work history`. Agent PIDs are
recorded so a restart can kill stale children; existing PRs are reconciled
instead of re-running the worker.

## Result contract

Every agent run writes a JSON result to an absolute path. The orchestrator
reads it and decides what to do. The contract is provider-independent.

## State

Each profile has its own state directory. `state.json` holds tasks, escalations,
counters, feed ETags and baseline failures. `status.json` is the human-readable
snapshot. Locks are per profile, so `start --all` can run multiple profiles.

## Worktrees

The harness clones the fork into `profiles/<profile>/repos/repo`, fetches `upstream`,
and creates a worktree per ticket and per review. `.env` is copied from the
clone so builds work. Worktrees are removed after delivery/review failures and
cleaned up after tasks finish.

## HITL

Ziki escalations are stored in state with the asking agent's name. The poll pass
uses that agent's key to read the answer. A `waiting_human` task is not picked
again until it is answered.

## Checks

Checks are data. The runner resolves commands through `toolchain`, optionally
appends changed files, parses JSON test events, and compares failures to the
base-branch baseline. A check can be optional.

## Ziki drift

Ziki changes. Work-feed kinds, statuses, platforms, routes, payloads, auth, rate
limits and UI paths are assumptions in `ziki.ts`, `types.ts`, `queue.ts`,
`orchestrator.ts`, prompts and fixtures. Re-check them against the live Ziki
API/UI periodically, then update code, docs, tests and examples together.
