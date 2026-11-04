# Safety

auto-work runs a coding agent unattended. Treat it like giving a capable
contractor shell access to the repository.

## Full-auto flags

`permissionMode: "auto"` maps to:

- opencode: `--auto`
- Claude Code: `--dangerously-skip-permissions`
- Codex: `--dangerously-bypass-approvals-and-sandbox`
- Gemini: `--yolo`

These grant broad tool access. Use them only when you accept that risk.

Recommended isolation:

- a container or VM,
- a dedicated OS user,
- a dedicated GitHub bot account with a fine-grained token,
- a fork or a repository where a bad PR is recoverable.

`permissionMode: "safe"` uses the least-privilege non-interactive mode. It may
block waiting for approval, which is not suitable for unattended runs.

## Secrets

- Ziki keys live in the env file next to the config, mode 600.
- Never put keys in `config.json`, prompts, or git.
- The orchestrator scans the staged diff for common secret patterns and refuses
  to deliver if it finds one. This is a backstop, not a sandbox.
- Protected files are rejected before commit. They are a backstop too: the agent
  may still have read them.

## Project env

- Put project values in the clone's `.env`/`.env.local`; they are copied into
  every worktree and stay protected from commit.
- `executor.env` and `checks[].env` are for non-file values. They live in the
  mode-600 config, so avoid long-lived secrets there when a `.env` works.
- Agent children inherit the loop's process env. Do not export secrets in the
  shell that starts the loop; use the env file instead.
- Missing env/tool/auth failures are treated as blockers and escalated.

## Notifications

- Default `hitl.notify: "auto"` uses the OS desktop notifier; no tokens.
- `command` mode runs a local command with `AW_TITLE`/`AW_BODY`. Keep any token
  in the env file or the command's own config, never in the notification text.
- Notifications contain only the count and Ziki link, no env values.

## GitHub

- `gh auth login` with the minimum scopes needed to open PRs and read checks.
- The loop never merges. A merger agent or a human does.
- Use a fork (`repo.url`) and target the upstream base branch.
- Do not run it against a repository you cannot restore.

## Caps and stop switches

- Daily caps for deliveries, reviews, discoveries and auxiliary work.
- Per-run limits: `--max-runtime` (default 2h), `--max-cycles`, `--until`,
  `--max-deliveries`, `--forever`. The loop finishes the current cycle, then
  stops and records the reason.
- Concurrency caps: 2 deliveries, 1 review, 2 auxiliary tasks, 1 discovery, and
  4 agents total (`maxConcurrent*`). `maxActiveClaims` caps deliveries per owner.
- `auto-work pause` stops work without killing the process.
- `auto-work stop` sends SIGTERM, aborts in-flight tasks, and kills child
  process trees. systemd units use `KillMode=control-group` and a stop timeout.
- On startup, stale agent PIDs are killed and stale worktrees are removed.
- `STOP` in the profile state directory is a file-based kill switch.
- `auto-work status [--verbose]` shows open escalations, counters, run limits,
  in-flight tasks and the last error.

## Human escalation

When the agent is blocked or a change is risky, it files a Ziki escalation and
marks the task `waiting_human`. The loop continues with other work. Answer in
Ziki; the loop resumes on a later cycle. The claim clocks pause while waiting.

## Review before publishing

The first few PRs should be reviewed by a human. The agent-owned checks and PR body
are not a substitute for review.
