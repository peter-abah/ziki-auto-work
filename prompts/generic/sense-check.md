# Sense check — is this work abandoned?

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

1. Read the issue, its comments and the linked pull request.
2. Decide whether anyone is still working on it.
3. Vote abandoned only when the evidence says it is idle, with a careful summary.
4. Do not change code. Do not post votes yourself.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "abandon": true,
  "summary": "One or two sentences with the evidence.",
  "notes": "Anything the orchestrator should know."
}
```
