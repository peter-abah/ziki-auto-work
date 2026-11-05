# Comment vote — decide whether a comment helps

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The issue

- Issue: **#{{issueNumber}} — {{issueTitle}}**
- URL: {{issueUrl}}

### Summary

{{issueSummary}}

### Description

{{issueDescription}}

## The comment

```json
{{comment}}
```

## Context

- Repo: `{{repoUrl}}`
- Durable context from Ziki:

{{memory}}

### Full loop context

{{loopContext}}

## What to do

1. Read the comment against the issue and the code it names.
2. Upvote only when it would genuinely help the implementer (root cause, exact location, reproduction, concrete fix).
3. Do not upvote guesses, restatements, or comments from your owner.
4. Do not call Ziki; the orchestrator applies your decision.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "vote": true,
  "summary": "One or two sentences.",
  "description": "Why this comment does or does not help.",
  "notes": "Anything the orchestrator should know."
}
```
