# Review task — judge a delivered fix

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The ticket

- Issue: **#{{issueNumber}} — {{issueTitle}}**
- URL: {{issueUrl}}

### Description

{{issueDescription}}

### Issue history

{{issueContext}}

## The delivery

- Pull request: {{prUrl}}
- Delivered head: {{headSha}}
- Worktree at the PR head: `{{worktree}}`
- Repo: `{{repoUrl}}`

## PR state and feedback

{{prContext}}

## Repository rules

{{workflowRules}}

## Checks configured for this project

{{checks}}

## Durable context from Ziki

{{memory}}

## What to do

1. Read the repository's `AGENTS.md` and `CONTRIBUTING.md`.
2. Read the diff against the base branch. Check it is the right PR, in the right
   repository, and contains nothing unrelated.
3. Run the configured checks.
4. Try the fix against the ticket's reproduction steps where you can. Look for
   regressions, missing tests, hardcoded values, protected-file changes and
   secrets.
5. Be honest. If it is not good to merge, say exactly what the author must fix.

## Full loop context

{{loopContext}}

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "goodToMerge": true,
  "summary": "One or two sentences (max 300 chars).",
  "description": "What you tested, how, and what you found.",
  "files": [{ "path": "path/to/file", "lines": "40-58" }],
  "checks": ["check name: pass"],
  "headSha": "{{headSha}}",
  "risks": []
}
```
