# auto-work

An autonomous **Ziki** work loop for your repository. It watches the work feed,
finds tickets, implements them in isolated worktrees, runs your checks, opens
pull requests, delivers them to Ziki, reviews other deliveries, and files
evidence-backed ideas — continuously.

It is provider-agnostic: use **opencode**, **Claude Code**, **Codex**, **Gemini
CLI**, or any custom command. It runs on **Linux, macOS, and Windows**.

## Quickstart

```bash
# from GitHub
npx github:peter-abah/ziki-auto-work init

# or clone
git clone https://github.com/peter-abah/ziki-auto-work
cd auto-work
./install.sh          # install.ps1 on Windows

auto-work doctor
auto-work run --once --dry-run
auto-work start
```

`auto-work init` asks for the minimum, detects your stack and installed coding
CLIs, writes the config, and points you at the next step.

## Or let your AI set it up

Tell your AI assistant:

> Set up auto-work for this repository. Read `docs/AI-SETUP.md` and follow it.

The repo ships [`AGENTS.md`](./AGENTS.md) and [`docs/AI-SETUP.md`](./docs/AI-SETUP.md) for exactly this. The AI
detects the environment, asks only for what is missing, writes the config, and
validates it. It does **not** start the loop unless you ask.

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

## Projects and workspaces

The config holds multiple **jobs**. Each job is one project + repo + platform +
agents + provider + checks + prompts.

```bash
auto-work init --job web
auto-work jobs
auto-work start --job zedu-desktop
auto-work start --all
auto-work status --all
```

Per-job state lives under `.../jobs/<job>/` (state, logs, worktrees, repo
clone, results, `NEEDS-HUMAN.md`), so jobs do not interfere.

## Prompts per project

Each job has its own prompt folder:

```
prompts/<job>/worker.md  confirm.md  triage.md  review.md  discovery.md  owner.md  pr.md
```

`auto-work init` copies the generic templates into your config directory and
points the job at them. Edit them freely. The engine passes project context
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
`work_authorization`, `blocker`, `scope_change`, `human_approval`). You get an
in-app notification; answer in Ziki. The task goes `waiting_human`, the loop
continues with other work, and resumes automatically when you answer. Claim
clocks pause while waiting.

Open items are mirrored to `NEEDS-HUMAN.md` and:

```bash
auto-work escalations
auto-work status
```

## Checks and safety

- Per-job `checks[]`: commands, `filesOnly`, `include`, `reporter: "json"`,
  `baseline`, timeouts, required/optional.
- Pre-existing test failures are baselined once per base SHA; only **new**
  failures block delivery.
- One ticket per branch/PR; `fix/<number>-<slug>`; ≤5 files.
- Protected files and secrets are rejected before commit.
- Daily caps, `maxActiveClaims`, `pause`/`resume`, and a `STOP` kill switch.
- The loop **never merges**. A merger agent does that on GitHub.

Full-auto flags (`--auto`, `--dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`, `--yolo`) grant broad tool access.
Read [`docs/safety.md`](./docs/safety.md) before running unattended.

## Commands

```bash
auto-work install [--keys-file <path>] [--service]
auto-work init [--job <name>] [--example <name>] [--from-file <path>] [--yes]
auto-work detect [--json]
auto-work models [--provider <p>] [--job <name>] [--json]
auto-work jobs
auto-work doctor [--job <name>]
auto-work start [--job <name>] [--foreground] [--once] [--dry-run] [--all]
auto-work run [--job <name>] [--once] [--dry-run]
auto-work stop | pause | resume | status [--all]
auto-work logs [--job <name>] [--lines 80] [--follow]
auto-work escalations | memory | prompts
auto-work config [--show] [--validate] [--migrate]
```

## Configuration

- Config: platform config dir + `auto-work/config.json`
- Secrets: same dir + `env` (mode 600)
- State: platform state dir + `auto-work/jobs/<job>/`

See [`docs/config.md`](./docs/config.md) for the full schema.

## Development

```bash
npm ci
npm run check
npm test
npm run build
```

Node 20+. TypeScript is dev-only; the runtime dependency is `cross-spawn` for
reliable Windows process launching.

## License

MIT. See [`LICENSE`](./LICENSE).
