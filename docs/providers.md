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
opencode run --auto --format json --dir <cwd> <prompt>
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
claude -p --output-format json <prompt> --dangerously-skip-permissions [--model <model>]
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
codex exec --json --dangerously-bypass-approvals-and-sandbox -C <cwd> [ -m <model> ] <prompt>
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
gemini -p --output-format json <prompt> --yolo --skip-trust [ -m <model> ]
```

- `permissionMode: "safe"` uses `--approval-mode auto_edit`.
- Gemini has no model-list command; pass a model name or leave it blank for the
  provider default.

## Config-defined providers

Any headless CLI can be added without changing auto-work:

```json
"providers": {
  "my-tool": {
    "id": "my-tool",
    "command": "my-tool",
    "args": ["run", "--yes", "--prompt", "{{prompt}}"],
    "promptMode": "arg",
    "resultMode": "file",
    "autoArgs": [],
    "safeArgs": [],
    "usage": { "regex": { "input": "input (\d+)", "output": "output (\d+)" } }
  }
}
```

`executor.provider` can be any built-in or custom id. `auto-work providers`
lists them; `auto-work providers --check` runs each provider's version check.

Placeholders: `{{prompt}}`, `{{cwd}}`, `{{resultPath}}`, `{{model}}`.

- `promptMode: "arg"` appends the prompt if no `{{prompt}}` placeholder exists.
- `promptMode: "stdin"` pipes the prompt to stdin instead.
- `resultMode: "file"` expects the agent to write `{{resultPath}}`.
- `resultMode: "stdout"` captures the final JSON object from stdout.

## Built-in shortlist (experimental)

The registry also includes experimental specs for Aider, Goose, GitHub Copilot
CLI, Cursor Agent, Qwen Code and Amp. Flags change between versions; run
`auto-work providers --check` and verify the command before relying on one.
IDE-only tools (Windsurf, Cline, Roo) need a CLI/headless mode and are otherwise
unsupported.

## Usage and quota

Provider JSON output is parsed for token usage where available. If a provider
has no usage data, `executor.usage.regex` or `executor.usage.estimate: true` can
supply a fallback; estimates are marked.

At `limits.maxTokensPerRun`, auto-work warns at `tokenWarnPercent` and stops
after the current task with `stopReason: "token-limit"`.

Provider limits are only acted on when a **failed agent result explicitly sets**
`providerLimit` to `"quota"`, `"rate-limit"` or `"context"`. Auto-work never
infers them from stdout, stderr, source code, line numbers or usage metadata.
When no explicit signal is present, failures follow normal retry/escalation
behaviour. A failed result may also set `environmentHint` for a genuinely
missing command, environment value or authentication prerequisite.

## Models and cost

- `null` means provider default.
- Per-role models let triage/review use a cheaper model:
  `executor.models: { "triage": "...", "review": "...", "vote": "..." }`.
  `vote` covers both bid votes and comment upvotes.
- Model names change. Use `auto-work models` where possible and free text
  otherwise.
- `auto-work doctor` shows the resolved model per role.

## Permission modes

`permissionMode: "auto"` uses the provider's bypass flags. This is required for
unattended runs, but it grants broad tool access. `"safe"` uses the
least-privilege mode and may block waiting for approval. Read
[`safety.md`](./safety.md).
