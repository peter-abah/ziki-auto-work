# AI setup guide

You are setting up **auto-work** for a user. Follow this checklist exactly.

## Hard rules

- **Do not start the loop.** Finish with `auto-work run --once --dry-run`, not
  `auto-work start`.
- **Do not commit secrets.** Ziki keys go in the env file, never in config,
  prompts, or git.
- Ask only for what you cannot detect.
- If the user wants full-auto flags, explain the risk first.

## 1. Detect the environment

```bash
auto-work detect --json
auto-work models --provider <detected-provider> --json
```

This reports the OS, Node version, stack files, installed coding CLIs, the
current config path, and the active job.

If `auto-work` is not installed yet:

```bash
npx github:peter-abah/ziki-auto-work detect --json
# or, from a clone:
./install.sh
```

## 2. Ask only the minimum

Ask the user for:

1. Ziki base URL (usually `https://ziki.dev`).
2. Ziki project ID and project slug.
3. Platform slug (`desktop`, `web`, `mobile`, or their own).
4. Repo clone URL (their fork) and upstream URL.
5. Base branch and GitHub repo (`owner/name`), fork owner, default branch.
6. Team lead handle (optional; needed for the PR template).
7. Agent key env names (workers and managers).
8. Coding CLI: `opencode`, `claude`, `codex`, `gemini`, or custom.
9. Model preference (optional; blank means provider default). Offer the
   candidates from `auto-work models`. Mention that per-role models can make
   triage/review cheaper.
10. Checks: use the detected stack preset (`flutter`, `node`, `python`) or ask
    for the commands.

Do not ask for values you can detect from the repo or the CLI.

## 3. Write the config

Preferred: create a JSON file and apply it.

```bash
auto-work init --from-file setup.json
auto-work config --validate
```

Or use the interactive wizard:

```bash
auto-work init
```

The config is written to the platform config directory:

- Linux: `~/.config/auto-work/config.json`
- macOS: `~/Library/Preferences/auto-work/config.json`
- Windows: `%APPDATA%\auto-work\config.json`

See [`config.md`](./config.md) for the full schema. The important parts:

- `ziki`: base URL, project ID, slug, platform.
- `repo`: fork clone, upstream, base, GitHub repo, fork owner, default branch,
  team lead, protected files, baseline file.
- `agents`: env var names for workers and managers.
- `executor`: provider, model, per-role models, timeout, permission mode.
- `checks`: the commands the loop runs before delivering.
- `prompts.dir`: per-project prompt folder.
- `pr.templateFile`: per-project PR template.
- `platformMatch`: keywords/regex used to filter the work feed.
- `discovery.parityFile`: optional parity/context file.

## 4. Add the Ziki keys

Create the env file next to the config, mode 600:

```bash
auto-work install --keys-file /path/to/keys.env
```

The file is `KEY=value` lines. The job references the names in
`agents.workers` and `agents.managers`. Never put keys in `config.json`.

## 5. Prompts

`auto-work init` copies the generic prompts into the config directory and sets
`prompts.dir` to that folder. If you are writing the config by hand, copy them:

```bash
auto-work prompts --job <job>
```

Then edit `prompts/<job>/worker.md`, `review.md`, `confirm.md`, `triage.md`,
`discovery.md`, `owner.md`, and `pr.md` for the project. The engine fills
`{{projectName}}`, `{{stack}}`, `{{checks}}`, `{{issueUrl}}`, `{{worktree}}`,
`{{memory}}`, `{{previousError}}`, and other placeholders.

## 6. Validate and dry-run

```bash
auto-work config --validate
auto-work doctor
auto-work run --once --dry-run
```

`doctor` checks keys, the selected provider, `gh` auth, the repo clone, the base
branch, fork access, and disk space. The dry run builds the queue and performs
**no Ziki or GitHub writes**.

## 7. Report back

Tell the user:

- the config path and active job,
- the provider and resolved models,
- the checks that will run,
- the number of items in the dry-run queue,
- that the loop is **not running**,
- the command to start it: `auto-work start`.

## Provider notes

- **opencode**: `opencode models` lists real IDs. `--auto` is used for headless
  runs.
- **Claude Code**: `--model` accepts aliases (`sonnet`, `opus`, `haiku`) or full
  names. `--dangerously-skip-permissions` is used in auto mode.
- **Codex**: model comes from `~/.codex/config.toml`; `-m` overrides.
  `--dangerously-bypass-approvals-and-sandbox` is used in auto mode.
- **Gemini CLI**: `-m` takes a free-text model; `--yolo` is used in auto mode.
- **custom**: set `executor.command` and `executor.args` with `{{prompt}}`,
  `{{cwd}}`, `{{resultPath}}`, and `{{model}}`.

## Windows

Use `install.ps1` or `npm i -g github:peter-abah/ziki-auto-work`. Paths resolve to
`%APPDATA%` and `%LOCALAPPDATA%`. The service command uses Task Scheduler when
available and falls back to a detached process. There is no `sudo`; run an
elevated terminal only if the user explicitly needs it.

## If something fails

- `doctor` FAIL lines are the source of truth.
- `gh auth status` fixes GitHub access.
- `ssh-add` fixes fork access.
- `auto-work config --validate` fixes config shape.
- `auto-work models` fixes model names.
- Do not paper over a failing check by starting the loop.
