# Follow-up task — address Zedu Desktop PR feedback for #{{issueNumber}}

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

The PR for **#{{issueNumber}} — {{issueTitle}}** already exists. Your job is to
address the review comments and failing checks below, not to redo the ticket.

## The ticket

- Issue: **#{{issueNumber}} — {{issueTitle}}**
- URL: {{issueUrl}}
- Platform: {{platform}}

### Description

{{issueDescription}}

## Workspace

- PR: {{prUrl}}
- Worktree: `{{worktree}}`
- Branch: `{{branch}}`
- Base: `{{base}}`
- Attempt: {{attempt}} / {{maxAttempts}}

## PR state and feedback

{{prContext}}

## Previous follow-up error

{{previousError}}

## Checks configured for this project

{{checks}}

## Repository rules

{{workflowRules}}

## Rules

1. Read `AGENTS.md` and `CONTRIBUTING.md` first. Follow the Riverpod/Result/AppPalette conventions.
2. Address only the actionable review comments and failing checks shown above.
   Do not redo the ticket or make unrelated changes.
3. Keep the diff small and within the repository limits. Never touch protected files.
4. Add or update tests for the review feedback.
5. Run the relevant checks from the worktree.
6. **Do not commit, push, open a new PR, merge, or call Ziki.** The orchestrator
   commits and pushes to the existing branch.
7. If a comment needs a product decision or access you do not have, write
   `"blocked": true` with a precise blocker.
8. If the branch has conflicts, rebase onto the current base and resolve them.

## Full loop context

{{loopContext}}

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "blocked": false,
  "prBody": "Updated complete Markdown PR body, or omit to keep the current one.",
  "summary": "What review feedback you addressed.",
  "description": "What changed and how you verified it.",
  "testResults": "Exact commands and their result.",
  "testedAgainst": "What environment or fixture you tested against.",
  "checks": ["check name: pass"],
  "files": ["path/to/changed/file"],
  "risks": [],
  "notes": [],
  "commitMessage": "fix({{issueNumber}}): address review feedback",
  "blocker": null
}
```

If blocked:

```json
{
  "ok": false,
  "blocked": true,
  "summary": "Why this needs a human.",
  "description": "What you tried and what you found.",
  "blocker": "The exact decision or access you need."
}
```
