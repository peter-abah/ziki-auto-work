# Configuration reference

The config is a **workspace** with one or more **profiles** (config version 3).

```json
{
  "version": 3,
  "activeProfile": "web",
  "defaults": {
    "executor": { "provider": "opencode", "model": null },
    "limits": { "maxActiveClaims": 2 },
    "pollSeconds": 120
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
        "defaultBranch": "main",
        "teamLead": "@lead",
        "protectedFiles": [".github/**", "AGENTS.md", ".env", ".env.*"],
        "baselineFile": "src/main.ts"
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
      "discovery": { "enabled": true, "parityFile": "PARITY.md", "maxIdeasPerRun": 3 },
      "limits": {
        "maxDeliveriesPerDay": 10,
        "maxReviewsPerDay": 20,
        "maxDiscoveriesPerDay": 5,
        "maxAuxPerCycle": 4,
        "maxActiveClaims": 2,
        "maxAttemptsPerTask": 3,
        "maxCyclesBeforeDiscovery": 6,
        "maxOpenEscalations": 5,
        "maxRuntimeMinutes": 120,
        "maxCycles": null,
        "stopAt": null,
        "maxDeliveriesTotal": null,
        "maxConcurrentDeliveries": 2,
        "maxConcurrentReviews": 1,
        "maxConcurrentAux": 2,
        "maxConcurrentDiscovery": 1,
        "maxConcurrentAgents": 4
      },
      "pollSeconds": 120,
      "memoryRefreshMinutes": 30,
      "hitl": { "enabled": true, "defaultType": "question", "notifyCommand": null }
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
- `defaultBranch`: used to check whether a merge is in the default branch.
- `teamLead`: PR template handle.
- `protectedFiles`: glob patterns; matched against changed paths and basenames.
- `baselineFile`: file passed to a `filesOnly` baseline check (optional).

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

- `provider`: `opencode`, `claude`, `codex`, `gemini`, `custom`.
- `model`: default model, or `null` for provider default.
- `models`: per-role overrides (`worker`, `review`, `triage`, `confirm`,
  `discovery`, `owner`).
- `timeoutMs`: per-agent timeout.
- `permissionMode`: `auto` (bypass flags) or `safe` (least-privilege; may block).
- `extraArgs`: provider-specific flags.
- `env`: extra environment variables.
- `command`, `args`, `promptMode`: custom provider only.

## checks

Each check:

- `name`: label.
- `command`: executable or a key from `toolchain`.
- `args`: arguments.
- `filesOnly`: append changed files.
- `include`: extensions for `filesOnly` (e.g. `[".dart"]`).
- `reporter`: `json` (Flutter-style test events) or `text`.
- `baseline`: compare failures to the base-branch baseline.
- `timeoutMs`.
- `required`: default true; optional checks do not fail the run.
- `env`: extra environment variables.

## prompts and pr

`prompts.dir` is the per-profile prompt folder. `pr.templateFile` is the PR body
template. Both are relative to the package root or absolute. The engine fills
placeholders such as `{{projectName}}`, `{{stack}}`, `{{checks}}`,
`{{issueUrl}}`, `{{worktree}}`, `{{memory}}`, `{{previousError}}`,
`{{issueContext}}`, `{{ticket}}`, `{{teamLead}}`.

## platformMatch

Keywords or a regex. Used to decide whether a work item belongs to this profile.
Issues already tagged with the platform are included regardless.

## discovery

`enabled`, optional `parityFile`, `maxIdeasPerRun`, `maxCyclesBeforeRun`.

## limits

Daily caps, active claims, retry attempts, discovery cadence and open
escalation cap.

Run limits:

- `maxRuntimeMinutes`: default 120; `null` disables the time limit.
- `maxCycles`: stop after N cycles; `null` disables.
- `stopAt`: ISO timestamp deadline; `null` disables.
- `maxDeliveriesTotal`: stop after N deliveries in this run; `null` disables.

These can be overridden per start with `--max-runtime`, `--max-cycles`,
`--until`, `--max-deliveries`, or `--forever`.

Concurrency:

- `maxConcurrentDeliveries` (default 2), capped by `maxActiveClaims`.
- `maxConcurrentReviews` (default 1).
- `maxConcurrentAux` (default 2).
- `maxConcurrentDiscovery` (default 1).
- `maxConcurrentAgents` (default 4) caps all in-flight tasks.

## doctor

`doctor.minFreeGb` sets the disk-space warning threshold (default 3).

## State locations

- Linux: `~/.local/state/auto-work/profiles/<profile>/`
- macOS: `~/Library/Application Support/auto-work/profiles/<profile>/`
- Windows: `%LOCALAPPDATA%\auto-work\profiles\<profile>\`

Each profile has `state.json`, `status.json`, `history.jsonl`,
`run-limits.json`, `logs/`, `worktrees/`, `repos/`, `results/`,
`NEEDS-HUMAN.md`, `OWNER-REQUESTS.md`.
