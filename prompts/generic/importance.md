# Importance task — mark what matters

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
- Durable context from Ziki:

{{memory}}

### Full loop context

{{loopContext}}

## What to do

1. Read the issue and judge whether it matters enough to mark important.
2. Importance gates nothing, so do not mark everything.
3. Do not change code. Do not post to Ziki.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "important": true,
  "summary": "One or two sentences saying why.",
  "notes": "Anything the orchestrator should know."
}
```
