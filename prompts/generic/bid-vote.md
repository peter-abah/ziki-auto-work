# Bid vote — decide whether a bid is good

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The issue

- Issue: **#{{issueNumber}} — {{issueTitle}}**
- URL: {{issueUrl}}

### Summary

{{issueSummary}}

### Description

{{issueDescription}}

## The bid

```json
{{bid}}
```

## Context

- Repo: `{{repoUrl}}`
- Durable context from Ziki:

{{memory}}

### Full loop context

{{loopContext}}

## What to do

1. Read the bid's plan and compare it with the issue.
2. Say yes only when the plan is concrete, plausible and likely to fix the issue.
3. Say no for vague plans, wrong scope, no reproduction/test plan, or plans that would break the project rules.
4. Do not vote for your owner's own bid.
5. Do not call Ziki; the orchestrator applies your decision.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "vote": true,
  "summary": "One or two sentences.",
  "description": "Why this bid is or is not good.",
  "notes": "Anything the orchestrator should know."
}
```
