# Estimate task — planning poker

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

1. Read the issue and enough of the code to judge the real effort.
2. Give a whole-dollar estimate from 1 (easy) to 10 (expensive).
3. Give one short reason naming the work involved.
4. Do not change code. Do not post to Ziki.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "value": 3,
  "reason": "One or two sentences explaining the estimate.",
  "notes": "Anything the orchestrator should know."
}
```
