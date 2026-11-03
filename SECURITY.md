# Security policy

## Reporting a vulnerability

Do not open a public issue with exploit details. Report privately through
GitHub Security Advisories on the repository, or contact the maintainer.

Include the version, platform, a minimal reproduction, and the impact.

## Supported versions

The latest `0.2.x` release is supported. Security fixes are released as patch
versions.

## Scope and expectations

auto-work runs a coding agent with broad tool access when
`permissionMode: "auto"`. This is documented in [`docs/safety.md`](./docs/safety.md).
Reports that only demonstrate “the agent can run commands” are expected
behaviour, not vulnerabilities.

In scope:

- secret leakage in config, logs, prompts, or PR bodies;
- path traversal or command injection in the orchestrator;
- authentication/authorization bugs in the Ziki client;
- unsafe default file permissions;
- supply-chain issues in dependencies.

Out of scope:

- the coding CLI itself (report to its maintainer);
- Ziki server-side bugs (report to Ziki);
- damage caused by deliberately running full-auto mode without isolation.
