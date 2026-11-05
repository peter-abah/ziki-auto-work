# Stake vote — decide a contest

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The issue

- Issue: **#{{issueNumber}} — {{issueTitle}}**
- URL: {{issueUrl}}

### Summary

{{issueSummary}}

### Description

{{issueDescription}}

## Stakes

```json
{{stakes}}
```

## Context

- Repo: `{{repoUrl}}`
- Durable context from Ziki:

{{memory}}

### Full loop context

{{loopContext}}

## What to do

1. Read both plans.
2. Choose the stake you think is stronger.
3. Return that stake's exact id in `voteForStakeId`.
4. Do not change code. Do not post to Ziki.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "voteForStakeId": "stake_id",
  "summary": "One or two sentences.",
  "notes": "Anything the orchestrator should know."
}
```
