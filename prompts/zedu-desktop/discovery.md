# Discovery task — Zedu Desktop parity

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

Find **real, observable gaps or bugs in Zedu Desktop** that are not already
tracked, and report them so the loop can fix them.

## Goal

Zedu Desktop (Flutter, Windows/macOS/Linux) must reach feature parity with the
web app (`zeduchat/zedu-fe`) and work correctly on every desktop platform.

## Context

- Repo: `{{repoUrl}}`
- Repo dir: `{{repoDir}}`
- Checks: {{checks}}
- Parity map:

{{parity}}

- Durable context from Ziki:

{{memory}}

## Existing desktop issues (do not duplicate these)

{{existingIssues}}

## What to do

1. Read `AGENTS.md`, `CONTRIBUTING.md`, the parity map and the desktop feature
   layout under `lib/features/`.
2. Compare desktop features against the web app's client features. Look for:
   - missing features (threads, files, calls, notifications, search, billing,
     roles, invites, appearance settings);
   - mocked or hardcoded behaviour (mock Agora tokens, fake members, hardcoded
     prices, fabricated workspaces);
   - cross-platform breakage (Linux keyring, system tray, window sizing,
     keyboard shortcuts, accessibility);
   - real bugs you can point to in code or reproduce.
3. Prefer issues small enough for one PR (≤5 files) with clear evidence.
4. Find at most **{{maxIdeas}}** new ideas. Quality over quantity.
5. For each idea, give concrete evidence: file paths and lines, the symptom, and
   how to verify the fix.

## What to write

Write **valid JSON** to `{{resultPath}}`:

```json
{
  "ok": true,
  "ideas": [
    {
      "title": "Short, specific title (3-200 chars)",
      "summary": "One or two sentences a person can understand (20-300 chars).",
      "description": "Markdown: symptom, code evidence, expected vs actual, suggested fix.",
      "evidence": "lib/features/...:123 — what is wrong there",
      "priority": "high",
      "platform": "desktop"
    }
  ],
  "notes": "Anything the orchestrator should know."
}
```

If you find nothing genuinely new, write `{"ok": true, "ideas": [], "notes": "..."}`.
Do not file anything in Ziki yourself; the orchestrator files the ideas.
