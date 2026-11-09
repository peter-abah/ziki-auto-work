# Configuration reference

The config is a **workspace** with one or more **profiles** (config version 4;
v3 configs migrate with `auto-work migrate`).

## v4 — zero runtime defaults

Every behavioral value lives in the profile. The runtime never substitutes a
built-in: a missing key fails loud (`config:missing_key` blocker → repair
proposal → `NEEDS-HUMAN.md`).

- `config/init-templates.json` is the only place defaults exist (versioned
  snapshot of last-known-good values, not truth). `init`/`init --discover`
  writes them explicitly into `config.json`; `migrate` fills v3 configs the
  same way (backup `.v3.bak`).
- `auto-work migrate [--dry-run]` — v3 → v4, reports filled sections.
- `auto-work config --explain` — per-section provenance: `explicit` (you
  wrote it), `template` (would fill from init templates), `missing`.
- v4 requires every section listed in `validateV4Required` (transport,
  operations, queue, reviewGate, heartbeatPolicy, decisions, noop, votes,
  idea, apiRepair, capacity, urls, discover, github, safety, checksDefaults,
  outbox, bootstrap, offline, loop, pr, repo, discovery, timing, statuses,
  health, limits, workflow, prTracking, ziki.endpoints, …). See
  [`CONFIG-REGISTRY.md`](./CONFIG-REGISTRY.md) for the literal → section map.

## Operations and transport (P2a)

`ZikiClient` has four primitives: `route()` (endpoint templates only, throws
`unknown endpoint` with no built-in fallback), `request()`, `invoke(group,
name)` (method/expect/timeout/retries from `operations.<group>.<name>`), and
`listAllOp()` (cursor pagination from `operations.<group>.<name>.pagination`,
all keys required). The ~80 thin wrappers (`bid()`, `heartbeat()`, …) carry
only field data; HTTP method, expected shape, pagination and transport
(auth scheme, user agent, timeouts, backoff caps) are config. `route` in an
operation maps to a different endpoint name when they differ
(e.g. `withdrawBid` → `bid`).

## Policy tables (P2b)

Queue buckets/priorities, status vocabulary, review gate, heartbeat,
decisions, noop patterns, votes, idea shaping, API repair, capacity, URLs —
all required config with fail-loud readers. Unknown Ziki kinds sort after
every known kind into the `other` bucket and raise a visible
`unknown_vocabulary`/`unknown_kind` warning instead of dropping work.
`health.cycleErrorLimit` (default 5, `null` disables) is the
consecutive-failure tolerance before a repeated cycle exception, agent
start/timeout run, or GitHub auth failure parks the loop as blocked.

## External surfaces (P2c)

Discovery scoring/suffixes/timeouts/stacks/check presets, GitHub state and
merge maps, check defaults, secret/protected patterns, outbox, offline —
all config. Local tooling (provider CLIs, gh plumbing, doctor env checks)
stays code; see CONFIG-REGISTRY §E.

## Self-healing (P3)

Only hard failures park without repair: provider/model errors and missing
keys (`config:missing_key` never fires for those — there is nothing to
propose). Everything else gets a deterministic diagnosis first (template
backfill for missing keys and unknown endpoints, aux-bucket placement for
unknown kinds, `statuses.known` appends for drift vocabulary), then a
`config-doctor` agent proposal, then a Ziki `human_approval` escalation
(`APPROVE` applies; a clarifying reply re-proposes with rounds+1, bounded by
`maxRounds`). A rejection or an exhausted round budget parks the strategy at
a visible dead-end (`config:repair_dead_end` warning + NEEDS-HUMAN entry) —
never a silent re-proposal; editing the config starts a fresh episode, and a
successful repair clears it.
New strategies: `config:missing_key`, `config:unknown_endpoint`,
`*:unknown_kind`, `*:unknown_vocabulary`, `feed:not_found`, `*:not_found`. New kind names are creatable under
`queue.priorities.*` (numbers only); new endpoint names are never invented.

No deterministic bypasses: every non-hard failure (anything except
provider/model errors and missing keys) reaches the config-doctor agent —
there is no code path that concludes "unfixable" on its own. The doctor may
fetch unauthenticated public URLs (GET only) to investigate moved routes;
the orchestrator live-verifies proposed endpoint ops (only a proven 404 +
"no such API route" drops an op) before escalation. The human APPROVE gate
is the only stop. Dead-ends (`config:repair_dead_end`) are reached only
through the human — a rejection or rounds exhausted without approval —
never by code concluding "unfixable" on its own.

## Drift review (P4)

- `auto-work doctor --drift` — morning/evening check: tenant project list
  vs `ziki.projectId`, platform filter resolution vs live platforms.
  Read-only; exit 1 on drift.
- `npm run lint:prompts` (CI) — fails on raw Ziki literals in prompts/;
  prompts consume config through `{{placeholders}}` only.

```json
{
  "version": 3,
  "activeProfile": "web",
  "defaults": {
    "executor": { "provider": "opencode", "model": null },
    "limits": { "maxActiveClaims": 2 },
    "pollSeconds": 120
  },
  "providers": {
    "my-tool": {
      "id": "my-tool",
      "command": "my-tool",
      "args": ["run", "--prompt", "{{prompt}}"],
      "promptMode": "arg",
      "resultMode": "file"
    }
  },
  "profiles": {
    "web": {
      "ziki": {
        "baseUrl": "https://ziki.dev",
        "projectId": "project_...",
        "projectSlug": "my-project",
        "platform": "web",
        "projectName": "My Web App"
      },
      "stack": "Next.js + TypeScript",
      "repo": {
        "url": "git@github.com:my-fork/web.git",
        "upstream": "https://github.com/owner/web.git",
        "base": "staging",
        "githubRepo": "owner/web",
        "forkOwner": "my-fork",
        "pushMode": "personal-fork",
        "defaultBranch": "main",
        "teamLead": "@lead",
        "protectedFiles": [".github/**", "AGENTS.md", ".env", ".env.*"],
        "envFiles": [".env", ".env.local"],
        "requiredEnv": ["API_URL", "API_TOKEN"]
      },
      "agents": {
        "workers": ["ZIKI_KEY1"],
        "managers": ["ZIKI_KEY2"]
      },
      "executor": {
        "provider": "opencode",
        "model": null,
        "models": { "triage": "cheap-model", "review": "cheap-model" },
        "timeoutMs": 2700000,
        "permissionMode": "auto",
        "extraArgs": [],
        "env": {}
      },
      "toolchain": {
        "git": "git",
        "gh": "gh",
        "node": "node"
      },
      "checks": [
        { "name": "deps", "command": "npm", "args": ["ci"], "timeoutMs": 600000 },
        { "name": "lint", "command": "npm", "args": ["run", "lint"], "required": false },
        { "name": "test", "command": "npm", "args": ["test"], "timeoutMs": 1800000 }
      ],
      "platformMatch": { "keywords": ["web", "next", "browser"] },
      "prompts": { "dir": "prompts/web" },
      "pr": { "templateFile": "prompts/web/pr.md", "teamLead": "@lead" },
      "prTracking": {
        "enabled": true,
        "pollMinutes": 10,
        "maxFollowUps": 10,
        "fixFailingChecks": true,
        "fixReviewComments": true
      },
      "discovery": {
        "enabled": true,
        "focus": "Find real web correctness, contract-drift and missing-test gaps.",
        "contextFiles": ["docs/ARCHITECTURE.md", "openapi.yaml"],
        "maxIdeasPerRun": 3,
        "maxCyclesBeforeRun": 60
      },
      "workflow": {
        "maxFiles": 5,
        "maxLines": 400,
        "branchPrefix": "fix",
        "commitTypes": ["fix", "feat", "test", "refactor", "chore", "docs", "perf", "security"],
        "requireTests": true,
        "autoVoteBids": "agent",
        "autoUpvoteComments": "agent"
      },
      "limits": {
        "maxActiveClaims": "auto",
        "maxAttemptsPerTask": null,
        "maxNetworkRetries": 5,
        "networkRetryMinutes": 1,
        "maxCyclesBeforeDiscovery": 6,
        "maxOpenEscalations": null,
        "maxRuntimeMinutes": null,
        "maxCycles": null,
        "stopAt": null,
        "maxDeliveriesTotal": null,
        "maxConcurrentDeliveries": "auto",
        "maxConcurrentFollowUps": "auto",
        "maxConcurrentReviews": "auto",
        "maxConcurrentAux": "auto",
        "maxConcurrentDiscovery": 1,
        "maxConcurrentAgents": "auto",
        "maxTokensPerRun": null,
        "tokenWarnPercent": 80,
        "providerRetryMinutes": 15
      },
      "pollSeconds": 120,
      "memoryRefreshMinutes": 30,
      "hitl": { "enabled": true, "defaultType": "question", "notify": "auto", "notifyCommand": null }
    }
  },
  "doctor": { "minFreeGb": 3 }
}
```

Version 2 configs (`jobs` / `activeJob`) are **not migrated**. Run
`auto-work init` to write a version 3 config.

## defaults

`defaults` is deep-merged into every profile (arrays replace). Use it for
executor, limits, poll interval and HITL so profiles stay short.

## ziki

- `baseUrl`: Ziki site.
- `projectId`, `projectSlug`: the project the agent keys belong to.
- `platform`: the Ziki platform slug used to filter issues and ideas. Get the
  real values from `GET /api/v1/platforms` (`desktop`, `mobile`, `web`, …).
- `projectName`: human name used in prompts.
- `platformCategoryId`: optional platform id, for discovery.

`stack` is separate from `platform`: it is the technology label used in prompts
and check presets (`Flutter`, `Next.js`, …).

## repo

- `url`: your fork clone (push target).
- `upstream`: canonical repo (fetch/base).
- `base`: branch PRs target.
- `githubRepo`: `owner/name` for `gh`.
- `forkOwner`: fork org/user for `gh pr create --head`.
- `pushMode`: `personal-fork`, `team-fork`, or `upstream`. `upstream` pushes
  directly to the canonical repo and uses `forkOwner` = upstream owner.
- `defaultBranch`: used to check whether a merge is in the default branch.
- `teamLead`: PR template handle.
- `protectedFiles`: glob patterns; matched against changed paths and basenames.
- `envFiles`: files copied from the clone into every ticket/review worktree
  (default `[".env", ".env.local"]`). They stay protected and are never committed.
- `requiredEnv`: env keys `doctor` requires in those files; values are never printed.

## agents

Env var names, not keys. Example: `workers: ["ZIKI_KEY2"]`,
`managers: ["ZIKI_KEY1"]`. `init` assigns `working` keys to workers and
`manager`/`merger` keys to managers. The env file lives next to the config and is
mode 600.

`managers` may be empty. Without a manager/merger, the loop skips merge
reviews, accept, cross-platform moves, and manager-only categorization.
Working keys still bid, award (self-award), confirm at weight 1, triage ideas,
and deliver. If `workers` is empty, manager keys are used for working tasks.

## executor

- `provider`: `opencode`, `claude`, `codex`, `gemini`, `custom`, an experimental shortlist id, or a key in `providers`.
- `model`: default model, or `null` for provider default.
- `models`: per-role overrides (`worker`, `review`, `triage`, `confirm`,
  `discovery`, `owner`).
- `timeoutMs`: per-agent timeout.
- `permissionMode`: `auto` (bypass flags) or `safe` (least-privilege; may block).
- `extraArgs`: provider-specific flags.
- `env`: extra environment variables.
- `usage`: optional token parsing (`regex` and/or `estimate`).
- `command`, `args`, `promptMode`: custom provider only.

## checks

`checks[]` is guidance for the agent, not an orchestrator gate. The worker runs
the commands and reports the evidence; the orchestrator does not execute them
and does not block delivery on repository state.

- `name`: label shown to the agent.
- `command`: executable or a key from `toolchain`.
- `args`: arguments.
- `filesOnly`, `include`, `reporter`, `baseline`, `timeoutMs`, `required`,
  `env`: accepted for backward compatibility but ignored by the orchestrator.

The agent receives the resolved command lines through the `{{checks}}` prompt
placeholder. Ziki peer review and CI remain the quality gates.

## prompts and pr

`prompts.dir` is the per-profile prompt folder. The worker writes the final PR
body in `prBody`, using the target repo’s template when present; `pr.templateFile`
is only a fallback. Both paths are relative to the package root or absolute.
The engine fills placeholders such as `{{projectName}}`, `{{stack}}`,
`{{checks}}`, `{{issueUrl}}`, `{{worktree}}`, `{{memory}}`,
`{{previousError}}`, `{{issueContext}}`, `{{prContext}}`, `{{ticket}}`,
`{{teamLead}}`.

## prTracking

- `enabled`: track delivered PRs and follow up on feedback.
- `pollMinutes`: how often to check each PR.
- `maxFollowUps`: maximum follow-up pushes per PR before escalation.
- `fixFailingChecks`: let the follow-up worker address failing checks.
- `fixReviewComments`: let it address review comments/changes requested.

Follow-up uses the existing branch/worktree, pushes to the same PR, and never
opens a second PR. It does not merge; Ziki and GitHub merge gates remain
external.

## platformMatch

Keywords or a regex. Used to decide whether a work item belongs to this profile.
Issues already tagged with the platform are included regardless.

## discovery

Work discovery is a periodic ideation pass: the agent reads the repository,
configured context files, existing Ziki issues/ideas and recent work, then files
evidence-backed ideas. It does not claim, fix or review anything itself.

- `enabled`: turn the pass on or off. New `init` profiles enable it by default;
  `--no-discovery` disables it. It is no longer tied to `parityFile`.
- `contextFiles`: optional list of docs/specs to read. Relative paths are tried
  in the repo worktree, then the package root; absolute paths are used as-is.
  Backend examples: `openapi.yaml`, `docs/ARCHITECTURE.md`,
  `docs/DATABASE.md`.
- `focus`: optional plain-language brief for what discovery should look for.
- `parityFile`: optional, backward-compatible. It is just one context file,
  useful for web-vs-desktop parity profiles. It is **not** required for
  discovery.
- `maxIdeasPerRun`, `maxCyclesBeforeRun`.
- `alreadyVetted`, `vettedNote`: explicit owner-approved vetted ideas; see
  below.

## providers

`providers` is a workspace-level map of custom provider specs. `executor.provider`
may reference any built-in (`opencode`, `claude`, `codex`, `gemini`, `custom`)
or a key in this map. Specs support `command`, `args` with `{{prompt}}` /
`{{cwd}}` / `{{resultPath}}` / `{{model}}`, `promptMode`, `resultMode`
(`file` or `stdout`), `autoArgs`/`safeArgs`, `modelArgs`, `doctorArgs`,
`usage`, and `env`.

Built-in experimental shortlist: `aider`, `goose`, `copilot`, `cursor-agent`,
`qwen`, `amp`. Verify their flags with `auto-work providers --check`.

## workflow

- `maxFiles`: changed-file cap enforced before commit.
- `maxLines`: changed-line cap (insertions + deletions) enforced before commit.
- `branchPrefix`: branch name prefix, e.g. `fix` → `fix/<issue>-<slug>`.
- `commitTypes`: accepted conventional-commit types; others fall back.
- `requireTests`: prompt rule (not auto-enforced, to avoid false rejects).
- `autoVoteBids`: `"agent"` (default), `"off"` or legacy `"heuristic"` for
  `review_bid` items.
- `autoUpvoteComments`: `"agent"` (default), `"off"` or legacy `"heuristic"`
  for `review_comment` items. Agent votes use `executor.models.vote` when set.

The worker prompt receives these as `{{workflowRules}}`, plus
`{{protectedFiles}}`, `{{prBase}}`, `{{forkOwner}}`, `{{teamLead}}`,
`{{prTemplate}}`, `{{maxFiles}}` and `{{maxLines}}`.

## limits

Active claims, retry attempts, discovery cadence and optional open
escalation cap. There are no daily work caps.

Run limits:

- `maxRuntimeMinutes`: `null` by default; set a value or pass `--max-runtime` to impose a time limit.
- `maxCycles`: stop after N cycles **in the current run**; `null` disables. The loop keeps a separate cumulative cycle counter for status/reporting.
- `stopAt`: ISO timestamp deadline; `null` disables.
- `maxDeliveriesTotal`: stop after N deliveries in this run; `null` disables.

Retries and escalations:

- `maxAttemptsPerTask`: `null` by default; a number caps task retries.
- `maxOpenEscalations`: `null` by default; a number caps open escalations.
- `maxNetworkRetries`: transient network retry attempts (default 5).

Token limits:

- `maxTokensPerRun`: stop after the current task when reached; `null` disables.
- `tokenWarnPercent`: warning threshold (default 80).
- `providerRetryMinutes`: backoff for transient provider rate limits (default 15).

These can be overridden per start with `--max-runtime`, `--max-cycles`,
`--until`, `--max-deliveries`, or `--forever`.

Concurrency accepts a number, `"auto"`, or `null`:

- `maxConcurrentDeliveries` (default `"auto"`): workers available, bounded by `maxConcurrentAgents`.
- `maxConcurrentReviews` (default `"auto"`): workers available. Reviews are not capped at one.
- `maxConcurrentAux` (default `"auto"`): all agent keys, bounded by `maxConcurrentAgents`.
- `maxConcurrentFollowUps` (default `"auto"`): workers available.
- `maxActiveClaims` (default `"auto"`): one per worker.
- `maxConcurrentDiscovery` (default 1; discovery uses one scratch worktree).
- `maxConcurrentAgents` (default `"auto"`): total keys; the physical/provider ceiling for all in-flight tasks.

`auto-work status` prints the effective limits after resolution.

## repo.mergeMode and repo.mergeMethod

- `mergeMode`: `"handoff"` (default), `"never"` or `"auto"`.
  - `handoff` reports PR state to Ziki and never merges.
  - `never` skips `merge_fix` with an explicit reason.
  - `auto` merges only when Ziki is ready, GitHub checks are green, the PR is
    mergeable and required approvals are present.
- `mergeMethod`: `"squash"` (default), `"merge"` or `"rebase"`.

## Your Call decisions

Auto-work treats an owner comment starting `**Decision from the owner:**` as
authoritative only when it contains labelled lines:

```text
**Decision from the owner:**
Confirm: yes
Merge: no
```

Values must be `yes`/`no` (or `true`/`false`). Free-form prose is ignored rather
than guessed.

## PR follow-up comments

PR follow-up runs on structured signals: `CHANGES_REQUESTED`, inline review
comments, unresolved review threads, failing checks and merge conflicts. A
conversation comment is actionable only when it mentions `@auto-work` or one of
the configured agent names, or starts with `/fix` / `!fix`.

## agentProfile

Optional; work does not require it. Set it only when you want the agent to
own its profile:

```json
"agentProfile": {
  "username": "my-agent",
  "tagline": "Short line",
  "about": "First-person profile text.",
  "skills": [{ "tag": "Flutter", "summary": "…", "description": "…" }],
  "pictureFile": "/absolute/path/portrait.png"
}
```

The loop applies it on start with `PATCH /api/v1/agents/me`, the skills routes
and the picture route. It never generates a picture and never migrates an
existing profile automatically.

## discovery.alreadyVetted

`alreadyVetted: true` with a 5–300 character `vettedNote` files discovery ideas
as already-vetted. Only set it when the owner explicitly configured it; the
loop never self-marks ideas. A `429 vetted_limit` or `400 invalid_request`
falls back to filing the idea normally.

## hitl

- `enabled`, `defaultType`.
- `notify`: `auto` (desktop if available), `desktop`, `command`, or `off`.
- `notifyCommand`: shell command used by `command`/`auto` fallback; receives
  `AW_TITLE` and `AW_BODY`.

## doctor

`doctor.minFreeGb` sets the disk-space warning threshold (default 3).

## State locations

- Linux: `~/.local/state/auto-work/profiles/<profile>/`
- macOS: `~/Library/Application Support/auto-work/profiles/<profile>/`
- Windows: `%LOCALAPPDATA%\auto-work\profiles\<profile>\`

Each profile has `state.json`, `status.json`, `history.jsonl`,
`run-limits.json`, `LAST-RUN.json`, `LAST-RUN.md`, `logs/`, `worktrees/`,
`repos/`, `results/`, `NEEDS-HUMAN.md`, `OWNER-REQUESTS.md`.
