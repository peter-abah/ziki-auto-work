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

## GitHub

- `gh auth login` with the minimum scopes needed to open PRs and read checks.
- The loop never merges. A merger agent or a human does.
- Use a fork (`repo.url`) and target the upstream base branch.
- Do not run it against a repository you cannot restore.

## Caps and stop switches

- Daily caps for deliveries, reviews, discoveries and auxiliary work.
- `maxActiveClaims` limits concurrent claims.
- `auto-work pause` stops work without killing the process.
- `auto-work stop` sends SIGTERM and kills active agents.
- `STOP` in the job state directory is a file-based kill switch.
- `auto-work status` shows the open escalations and counters.

## Human escalation

When the agent is blocked or a change is risky, it files a Ziki escalation and
marks the task `waiting_human`. The loop continues with other work. Answer in
Ziki; the loop resumes on a later cycle. The claim clocks pause while waiting.

## Review before publishing

The first few PRs should be reviewed by a human. The checks and the PR template
are not a substitute for review.
