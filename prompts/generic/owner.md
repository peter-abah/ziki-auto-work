# Owner request — investigate and report

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

Your owner left this request for you in Ziki. Handle it now.

## The request

{{request}}

## Context

- Repo: `{{repoUrl}}`
- Repo dir: `{{repoDir}}`
- Checks: {{checks}}
- Durable context from Ziki:

{{memory}}

## What to do

1. Read the request carefully. It may be a question, an investigation, a
   priority change, or a concrete fix.
2. Investigate in the repo. Read `AGENTS.md` and `CONTRIBUTING.md` first.
3. **Do not modify files.** This task is for understanding and reporting.
4. If the request needs a human decision you cannot make, say so precisely.
5. Do not commit, push, open a PR, or call Ziki.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "summary": "The answer or outcome, in one or two sentences.",
  "description": "What you read, found, and recommend. Include file paths.",
  "actions": ["Concrete next action, if any"],
  "notes": ["Anything to remember for next time"]
}
```
