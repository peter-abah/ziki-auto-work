# Contributing

## Setup

```bash
npm ci
npm run check
npm test
npm run build
```

Node 20+. The only runtime dependency is `cross-spawn` (reliable Windows process
launching). TypeScript is dev-only.

## Rules

- No project-specific literals in `src/`. Projects live in config; prompts live
  in `prompts/<job>/`; PR templates live in `prompts/<job>/pr.md`.
- Keep the result contract stable: every agent writes JSON to an absolute
  `resultPath`.
- Do not add a model catalog. Use provider discovery or free text.
- Do not hardcode paths, project IDs, repo names, team leads, or platform
  keywords.
- Windows, macOS and Linux are supported. Test path and spawn changes on all
  three where possible.
- Never log secrets. The env file is mode 600 and never committed.

## Tests

- `node:test` via `npm test`.
- Add tests for pure logic: config, migration, URLs, queue, checks, providers,
  PR rendering.
- Do not make tests depend on the user's real config or state. Use temp
  directories and env overrides.

## Prompts

Prompts are data. Keep placeholders in `{{double_braces}}` and document any new
placeholder in the engine and in `docs/config.md`.

## Pull requests

- One concern per PR.
- Include the command output for `npm run check`, `npm test` and `npm run build`.
- Describe platform-specific changes (especially Windows spawning).
