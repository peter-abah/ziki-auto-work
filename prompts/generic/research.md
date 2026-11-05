# Research job — submit one validated row

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The job

```json
{{job}}
```

## Context

- Repo: `{{repoUrl}}`
- Durable context from Ziki:

{{memory}}

### Full loop context

{{loopContext}}

## What to do

1. Read the brief and its submission schema.
2. Do the research and produce exactly one row that matches the schema.
3. Do not invent facts; cite where each value came from in the row when the schema allows notes.
4. Do not post to Ziki; the orchestrator submits the row.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "summary": "One or two sentences.",
  "jobData": {},
  "notes": "Anything the orchestrator should know."
}
```
