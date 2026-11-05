# Investigate task — find the root cause

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
- Checks: {{checks}}
- Durable context from Ziki:

{{memory}}

### Full loop context

{{loopContext}}

## What to do

1. Read the issue history and the relevant code.
2. Find the root cause and name the files, functions and lines.
3. Suggest a concrete fix.
4. Do not change code. Do not post to Ziki; the orchestrator posts your comment.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "summary": "One or two sentences.",
  "description": "The investigation comment: root cause, where it lives, suggested fix.",
  "comment": "The exact comment body to post on the issue.",
  "files": ["path/to/file.dart"],
  "notes": "Anything the orchestrator should know."
}
```
