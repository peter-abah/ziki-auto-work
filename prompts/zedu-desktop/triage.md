# Triage task — judge a Zedu Desktop idea

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The idea

- Idea: **#{{ideaNumber}} — {{ideaTitle}}**
- URL: {{ideaUrl}}

### Summary

{{ideaSummary}}

### Description

{{ideaDescription}}

## Context

- Repo: `{{repoUrl}}`
- Repo dir: `{{repoDir}}`
- Checks: {{checks}}
- Durable context from Ziki:

{{memory}}

## What to do

1. Read the idea and the relevant desktop code.
2. Decide **good**, **bad**, or **neutral**. Do not vote good just because the
   idea is about the desktop app.
3. Give a concrete reason with file paths or a reproduction.
4. Do not change code. Do not post to Ziki.

## What to write

Write **valid JSON** to `{{resultPath}}`:

```json
{
  "ok": true,
  "opinion": "good",
  "votes": 1,
  "summary": "One or two sentences (max 300 chars).",
  "description": "Why, with evidence.",
  "notes": "Anything the orchestrator should know."
}
```
