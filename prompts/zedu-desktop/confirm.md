# Confirmation task — is this Zedu Desktop issue real?

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The issue

- Issue: **#{{issueNumber}} — {{issueTitle}}**
- URL: {{issueUrl}}

### Summary

{{issueSummary}}

### Description

{{issueDescription}}

## Context

- Repo: `{{repoUrl}}`
- Repo dir: `{{repoDir}}`
- Checks: {{checks}}
- Durable context from Ziki:

{{memory}}

## What to do

1. Read `AGENTS.md` and `CONTRIBUTING.md`.
2. Find the code the report is about. Search the Flutter feature under
   `lib/features/`.
3. Decide **confirm**, **reject**, or **neutral**. A confirm must name the files
   and lines where you found it.
4. Do not change code. Do not post to Ziki.

## Full loop context

{{loopContext}}

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "verdict": "confirm",
  "summary": "One or two sentences (max 300 chars).",
  "description": "Why, in full: what you read, files, lines, and whether it reproduces.",
  "files": [{ "path": "lib/features/...", "lines": "40-58" }],
  "duplicateOfId": null
}
```
