# Providers

auto-work does not embed a model. It runs your coding CLI in non-interactive
mode and tells it to write a JSON result file. The orchestrator handles Ziki and
GitHub.

## opencode

```bash
opencode auth login        # once
opencode models            # real model IDs
```

Command built by auto-work:

```bash
opencode run --auto --format default --dir <cwd> <prompt>
```

- `--auto` auto-approves tool permissions.
- `--model <id>` is added when a model is configured.
- `opencode models` is the source of truth for model IDs, including custom
  providers.

## Claude Code

```bash
claude --version
claude          # authenticate once
```

Command:

```bash
claude -p <prompt> --dangerously-skip-permissions [--model <model>]
```

- `--model` accepts aliases (`sonnet`, `opus`, `haiku`) or full names.
- `permissionMode: "safe"` uses `--permission-mode acceptEdits` instead; this
  may block in headless runs.
- Provider-specific cost flags (e.g. `--max-budget-usd`) can go in
  `executor.extraArgs`.

## Codex

```bash
codex --version
# model is read from ~/.codex/config.toml; -m overrides
```

Command:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox -C <cwd> [ -m <model> ] <prompt>
```

- `permissionMode: "safe"` uses `-s workspace-write`.
- `auto-work models --provider codex` reads `model` from
  `~/.codex/config.toml`.

## Gemini CLI

```bash
gemini --version
```

Command:

```bash
gemini -p <prompt> --yolo --skip-trust [ -m <model> ]
```

- `permissionMode: "safe"` uses `--approval-mode auto_edit`.
- Gemini has no model-list command; pass a model name or leave it blank for the
  provider default.

## custom

```json
"executor": {
  "provider": "custom",
  "command": "my-agent",
  "args": ["run", "--prompt", "{{prompt}}", "--cwd", "{{cwd}}"],
  "promptMode": "arg"
}
```

Placeholders: `{{prompt}}`, `{{cwd}}`, `{{resultPath}}`, `{{model}}`.

- `promptMode: "arg"` appends the prompt if no `{{prompt}}` placeholder exists.
- `promptMode: "stdin"` pipes the prompt to stdin instead.

Your command must write the result JSON to `{{resultPath}}` (the prompt includes
the absolute path).

## Models and cost

- `null` means provider default.
- Per-role models let triage/review use a cheaper model:
  `executor.models: { "triage": "...", "review": "..." }`.
- Model names change. Use `auto-work models` where possible and free text
  otherwise.
- `auto-work doctor` shows the resolved model per role.

## Permission modes

`permissionMode: "auto"` uses the provider's bypass flags. This is required for
unattended runs, but it grants broad tool access. `"safe"` uses the
least-privilege mode and may block waiting for approval. Read
[`safety.md`](./safety.md).
