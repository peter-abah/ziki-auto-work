# auto-work — instructions for AI assistants

If the user asks you to set up, configure, or run **auto-work**, read
[`docs/AI-SETUP.md`](./docs/AI-SETUP.md) and follow it.

Hard rules:

- **Do not start the loop** unless the user explicitly asks. Finish with
  `auto-work run --once --dry-run`, not `auto-work start`.
- **Do not commit secrets.** Agent keys go in the env file, never in config,
  prompts, or git.
- Ask only for the minimum. Detect the environment first with
  `auto-work detect`.
- **Keys first.** Import and validate keys with `auto-work keys import <file>`
  (or `init --keys-file <file>`) before asking for a project or platform. Ziki
  resolves both from the key. At least one `working` agent is required;
  manager/merger keys are optional.
- **No repo assumption.** The user may only have Ziki keys. Use
  `auto-work init --discover` (or `--github-repo`/`--fork-owner`) to find,
  fork and clone the repository; never invent one.
- **Run limits.** Every `start` has a limit (default 2 hours). Offer
  `--max-runtime`, `--max-cycles`, `--until`, `--max-deliveries`, or `--forever`.
- Prefer `auto-work init` and `auto-work config --validate` over hand-writing
  JSON. If you do write config, validate it.
- Full-auto flags (`--auto`, `--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--yolo`) grant broad tool
  access. Explain that before choosing them.
- Never publish, push, or create GitHub resources for the user unless they
  explicitly ask for that action.
- **Branches:** commit and push only to `dev`. Never push or merge to `main`;
  `main` is release-only and is updated by a tested squash-merged PR from
  `dev`.
