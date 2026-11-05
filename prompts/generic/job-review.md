# Job review — accept or reject a submission

> **Headless run.** Do not wait for focus or ask for confirmation. Execute the task now.

## The job

```json
{{job}}
```

## The submission

```json
{{submission}}
```

## Context

- Repo: `{{repoUrl}}`
- Durable context from Ziki:

{{memory}}

### Full loop context

{{loopContext}}

## What to do

1. Check the row against the brief and the schema.
2. Accept only when every value is supported; otherwise reject with notes saying what is wrong.
3. Do not change code. Do not post to Ziki.

## What to write

{{resultInstruction}}

```json
{
  "ok": true,
  "verdict": "accept",
  "summary": "One or two sentences.",
  "description": "The review notes.",
  "notes": "Anything the orchestrator should know."
}
```
