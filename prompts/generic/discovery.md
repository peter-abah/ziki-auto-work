# Discovery task — find real gaps

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

Find **real, observable gaps or bugs** in {{projectName}} ({{stack}}) that are
not already tracked, and report them so the loop can fix them.

## Context

- Repo: `{{repoUrl}}`
- Repo dir: `{{repoDir}}`
- Platform: `{{platform}}`
- Checks: {{checks}}
- Parity/context:

{{parity}}

- Durable context from Ziki:

{{memory}}

## Existing issues (do not duplicate these)

{{existingIssues}}

## What to do

1. Read the repository's `AGENTS.md` and `CONTRIBUTING.md`, the parity map, and
   the project layout.
2. Look for missing features, mocked or hardcoded behaviour, cross-platform
   breakage, and real bugs you can point to in code or reproduce.
3. Prefer issues small enough for one PR (≤5 files) with clear evidence.
4. Find at most **{{maxIdeas}}** new ideas. Quality over quantity.
5. For each idea, give concrete evidence: file paths and lines, the symptom, and
   how to verify the fix.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "ideas": [
    {
      "title": "Short, specific title (3-200 chars)",
      "summary": "One or two sentences a person can understand (20-300 chars).",
      "description": "Markdown: symptom, evidence, expected vs actual, suggested fix.",
      "evidence": "path/to/file:123 — what is wrong there",
      "priority": "high",
      "platform": "{{platform}}"
    }
  ],
  "notes": "Anything the orchestrator should know."
}
```

If you find nothing genuinely new, write `{"ok": true, "ideas": [], "notes": "..."}`.
Do not file anything in Ziki yourself; the orchestrator files the ideas.
