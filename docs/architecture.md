# Architecture

```
src/
  cli.ts             commands, init wizard, detect, models, keys, uninstall
  config.ts          config v3, defaults, validation, env
  keys.ts            key import, validation and role assignment
  types.ts           shared types
  orchestrator.ts    the loop and state machine
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
9. `delivery` — confirm/bid/award/accept, implement, check, push, PR, deliver.
10. `review` — test verdicts and manager merge reviews.
11. `aux` — PR reports, bid votes, awards, comment upvotes, categorisation,
    idea triage, confirmations.
12. `discovery` — every N cycles, file evidence-backed ideas.
13. `cleanup` — remove old worktrees.
14. save state and sleep.

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
