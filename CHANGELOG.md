# Changelog

## 0.2.0

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

## 0.1.0

- Initial public release.
- TypeScript, config-driven engine with multiple jobs.
- Providers: opencode, Claude Code, Codex, Gemini CLI, custom.
- Per-job checks, prompts, PR templates, platform matching, protected files.
- Non-blocking human-in-the-loop via Ziki escalations and inbox.
- Durable memory via Ziki agent notes, shared notes, instructions, history and
  mistakes.
- Per-ticket and review worktrees; baseline of pre-existing test failures.
- Linux, macOS and Windows paths, spawning, logging and service setup.
- `init`, `detect`, `models`, `jobs`, `doctor`, `start --all`, `pause`,
  `resume`, `status`, `logs`, `escalations`, `memory`, `config`.
