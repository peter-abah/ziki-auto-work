# Config registry — every hardcoded literal and its config home

> P0 audit (dev `344fa80`, 210 tests green). Each row: where the literal lives,
> what breaks on a Ziki/external change, the target config section, and the
> implementation phase. Runtime rule after migration: missing key →
> `config:missing_key` blocker + `config-doctor` proposal + NEEDS-HUMAN, never
> a silent substitute. `init --discover` (backed by
> `config/init-templates.json`) is the only place defaults exist — written
> explicitly into `config.json`, never applied at runtime.

## A. Endpoints + transport + operations (P2a)

| # | Source | Literal | Breaks when | Config home |
|---|---|---|---|---|
| A1 | `src/ziki-endpoints.ts:22` | `DEFAULT_ENDPOINTS` (~60 `group.name → /api/v1/…` templates) | Ziki renames any route / adds org prefix | `ziki.endpoints` (exists; make required, remove fallback in `resolveEndpoint`/`ZikiClient.route`) |
| A2 | `src/ziki.ts:175-176,162` | `route()` falls back to `DEFAULT_ENDPOINTS`; ctor `endpoints ?? DEFAULT_ENDPOINTS` | same as A1 — stale built-in wins over config | `ziki.endpoints` required; `route()` throws `unknown_endpoint` when absent |
| A3 | `src/ziki.ts:383-975` | ~80 named wrappers (`bid()`, `awardBid()`, `heartbeat()`, `delivery()`, `createIdea()`, `listIssues()`, …) each with inline HTTP method | Ziki changes method for an op (POST→PUT etc.) | `ziki.operations.<group>.<name>.method`; generic `invoke()` replaces wrappers |
| A4 | `src/ziki.ts:486-975` | per-method query keys (`projectId`, `platform`, `status`, `limit`, `cursor`) and body keys (`title/summary/description/areaId/typeId/proofLinks/attachmentIds/acknowledgeSimilar/alreadyVetted/vettedNote`, confirm `confirm\|reject\|neutral`, verdict `good\|bad\|neutral`) | Ziki renames/adds/drops a field → 400/422 or silent wrong call | `ziki.operations.<op>.{query[],body[]}` |
| A5 | `src/ziki.ts:499-509,581-591,964` | pagination `limit ?? 100`, `20` pages, `max ?? 600`, `data.items` / `data.nextCursor` | Ziki renames cursor fields or caps pages | `ziki.operations.<op>.pagination{limitKey,cursorKey,itemsKey,nextCursorKey,defaultLimit,maxPages,maxItems}` |
| A6 | `src/ziki.ts:156,163-164,302-310` | `baseUrl ?? https://ziki.dev`, `agentName ?? "agent"`, `timeoutMs ?? 60_000`, `retries ?? 3`, `Bearer` scheme, `User-Agent: ziki-auto-work/0.1`, ETag/`If-None-Match`/304 | Ziki changes auth scheme, base, timeout/RL policy | `ziki.transport.{baseUrl,agentName,authScheme,userAgent,defaultTimeoutMs,defaultRetries,backoffCapMs,retryAfterCapMs}` |
| A7 | `src/ziki.ts:98,352` | backoff `min(60s, 1s*2^attempt)`, `min(30s, …)`; `retryAfterMs`/`ratelimit-reset` parsing | provider/RL header change | `ziki.transport.*` (caps) — parser stays code, caps config |
| A8 | `src/ziki.ts:384,471-484 etc.` | `expect: feed|list|object` per call; `assertResponseShape` + preview `slice(0,120)` | Ziki reshapes payload → empty queue instead of loud error | `ziki.operations.<op>.expect`; preview length → `ziki.transport.previewChars` |
| A9 | `src/ziki.ts:547,551` | `idempotencyKey ?? randomUUID()` on createIdea | dupe-create policy change | `ziki.operations.ideas.list.idempotency` (bool) |

## B. Queue + statuses + policy tables (P2b)

| # | Source | Literal | Breaks when | Config home |
|---|---|---|---|---|
| B1 | `src/queue.ts:3-38` | `PRIORITY` map (37 kinds → 1..33) | new Ziki kind gets no/arbitrary priority | `queue.priorities: Record<kind,number>` (required; unknown → warning, sorted last) |
| B2 | `src/queue.ts:40-82` | `OWNER/WORK/REVIEW/AUX_KINDS`, `KNOWN_KINDS` | new kind silently bucketed `other`/dropped | `queue.buckets.{owner,work,review,aux}: string[]` required |
| B3 | `src/queue.ts:84-91` | `NO_ISSUE_KINDS` (owner_request, categorize, research_job, …) | Ziki adds issueless kind → mis-keyed tasks | `queue.noIssueKinds: string[]` |
| B4 | `src/queue.ts:132` | `recentMs ?? 30*60*1000` | — (tuning) | `queue.recentMs` |
| B5 | `src/config.ts:116-135` + `src/orchestrator.ts:154,159,169,179` | `DEFAULT_ZIKI_STATUSES` + runtime fallbacks (`requires_confirmation/open/in_progress`, `resolved/closed/done/merge/accepted`, `terminalSubstatus done/merge`, `confirmation`) + ~10 literal sites (`on_dev/on_staging/on_prod/archived/converted/rejected`, `requires_confirmation` gates, deployment-suffix check) | Ziki renames any status → work skipped or done-state missed | `statuses.*` required (no fallback); all sites read config; unknown → `unknown_vocabulary` warning |
| B6 | `src/review-gate.ts:23-24` | `TRANSIENT 5min / TERMINAL 30min` | — (tuning) | `reviewGate.{transientMs,terminalMs}` |
| B7 | `src/review-gate.ts:26-31,60-84` | `state !== "OPEN"`, `merged`, `isDraft`, `checks passing\|failing\|pending\|none`, `mergeable false`, workflow keys `verdictsNeeded\|testVerdictsNeeded\|requiredTestVerdicts\|reviewsRequired`, `goodToMerge===true && current!==false` | Ziki/GitHub renames state/check/mergeable or workflow key | `reviewGate.{openState,mergedFlag,draftFlag,checkStates,workflowKeys,verdictRule}` |
| B8 | `src/heartbeat.ts:3,41-66` | `HEARTBEAT_INTERVAL 10min`; eligible `queued\|claimed\|working\|waiting_human\|delivered`; lost on `403/404/409/410`; `429→15min` else `5min`; workflow key `heartbeatMinutes`; `min(live, fallback)` | Ziki changes claim lifecycle/heartbeat policy | `heartbeat.{intervalMs,eligibleStates,lostStatuses,rateLimitMs,genericMs,workflowKey}` (`heartbeatMs:null` = derive stays explicit) |
| B9 | `src/decisions.ts:3-36` | marker `**Decision from the owner:**`; kinds `confirm\|merge`; answers `yes\|y\|true / no\|n\|false`; `:=\|=` seps, comma split | owner-format change → decisions ignored | `decisions.{marker,kinds,trueWords,falseWords,separators}` |
| B10 | `src/noop.ts:1,12-17` | statuses `400/409/422` + regexes (nothing to reclaim, not stale, not awaiting confirmation, already judgements/accepted/reviewed, not awaiting/reviewable, valid JSON body) | Ziki rewords errors → retries instead of skip (or vice versa) | `noop.{statuses,patterns: Record<action,string[]>}` (regex strings, compiled at load) |
| B11 | `src/votes.ts:1-16` | fallback `"agent"`; heuristic `len<40`, keywords `fix\|implement\|add\|update\|test\|change`, `root cause\|reproduction\|file:\|.dart:` | — (policy) | `votes.{defaultPolicy,bidMinChars,bidKeywords,commentKeywords}` |
| B12 | `src/idea-input.ts:1,14-15` | fallback `""`, min `20` + suffix `" — desktop parity gap."`, `slice(0,300)` | — (policy; suffix is zedu-specific) | `idea.{summaryMin,suffix,summaryMax}` |
| B13 | `src/api-repair.ts:61-99` | deterministic `2` repairs + `1` agent repair on `400\|422` | — (policy) | `apiRepair.{deterministicRetries,agentRepairs,statuses[]}` |
| B14 | `src/capacity.ts:17-47` | `atLeastOne` floor 1; `"auto"`→worker-count resolution; discovery/owner pinned `1` | — (policy) | `capacity.{floor,autoRule,discoverySlots,ownerSlots}` (or keep `limits` + document rule in config schema) |
| B15 | `src/work-key.ts:5-7`, `src/urls.ts` | `on_dev\|on_staging\|on_prod → dev\|staging\|prod`; `key:/issue:/idea:` prefixes; `/{org}/{project}/{n}`, `/ideas/{n}`, `/inbox`; labels `#n title` | Ziki renames envs/URL shape | `urls.{envSuffixes,keyPrefixes,issuePath,ideaPath,inboxPath,labelFormats}` |

## C. External surfaces (P2c)

| # | Source | Literal | Breaks when | Config home |
|---|---|---|---|---|
| C1 | `src/discover.ts:38-42,68-86` | `PLATFORM_SUFFIXES`; scores `60/40/100/25/10/5`, `stars/100 cap 10`; archived filter | new platform / repo naming → wrong fork picked | `discover.{platformSuffixes,scores,starCap,skipArchived}` |
| C2 | `src/discover.ts:44-52,263-267,560` (cli) | repo URL regexes; stack detect (`pubspec→flutter` etc.); `flutter→desktop else web`; `gh` timeouts `60s/20s` | new host/stack/platform | `discover.{urlPatterns,stackMap,stackPlatform, timeouts}` |
| C3 | `src/providers/specs.ts`, `src/providers/index.ts` | built-in commands/args (aider/goose/copilot/cursor/qwen/amp + adapters); `--version`/`models` probes `20s/60s`; `resultMode/promptMode`, `{{prompt}}\|{{model}}\|{{cwd}}\|{{resultPath}}` | provider CLI changes flags | `providers.*` seed from `init-templates.json` (built-ins become config data, code only executes) |
| C4 | `src/github.ts` | `gh pr create\|view\|merge\|edit` flags + field list; `MERGED\|MERGEABLE\|CONFLICTING`; `--merge\|--squash\|--rebase` (default squash); `upstream/{base}` refs, `upstream` remote mgmt, `worktree -b\|--detach`, `rev-parse/diff/rev-list`; `300s` timeouts | gh CLI or PR-schema change | `github.{commands,fields,stateMap,mergeFlags,refs, timeouts}` |
| C5 | `src/checks.ts:83,113-125`, `src/rules.ts:11` | `timeout ?? 20min`, `tail 40`, `required !== false`, `filesOnly/include`, `testStart\|testDone\|failure\|error` JSON parsing, `/test/` normalize; `DEFAULT_PROTECTED` globs + `re:` prefix | new test reporter / repo layout | `checks.defaults.{timeoutMs,tailLines,requiredDefault,reporterParsers}` + `safety.protectedFiles` |
| C6 | `src/checks.ts:148-156` | 6 `SECRET_PATTERNS` | new secret format missed (or FP blocks delivery) | `safety.secretPatterns: string[]` (regex strings) |
| C7 | `src/outbox.ts:6-7,82-90` | `MAX_ATTEMPTS 25`, `MAX_PER_FLUSH 5`, FIFO stop-on-first-failure, kinds `createIdea\|reportPrStatus\|reportDeployment` | — (policy) | `outbox.{maxAttempts,maxPerFlush,fifo,kinds}` |
| C8 | `src/bootstrap.ts` | `BOOTSTRAP.json`/`NEEDS-HUMAN.md` names, reason slices `500/200`, notify truncation `500`, `agentName "bootstrap"` | — (policy) | `bootstrap.{stateFile,needsFile,slices,agentName}` |
| C9 | `prompts/generic/*.md` (19), `prompts/zedu-desktop/*.md` (18) | embedded status names, `/api/v1` paths, `project_zedu`, verdict language | Ziki renames → agent acts on stale instructions | prompt lint: raw literals banned, must use `{{var}}`; vars supplied from config in `loop-context.ts`/`agent.ts` |
| C10 | `src/cli.ts:303-332,427-432` | check presets (flutter `pub get`/`analyze --fatal-infos`, npm `ci`, pip `install -e .`, `600s`), `commitTypes`, `branchPrefix fix`, `maxFiles 5/maxLines 400`, `pollSeconds 120`, `memoryRefresh 30`, `prTracking{on,10,10}`, `discovery{off,3}` | — (init-time only after P1; must move to `init-templates.json`) | `config/init-templates.json` (init reads, runtime never does) |

## D. Health/timing/backoff (covered by P1/P3, listed for completeness)

| # | Source | Literal | Config home |
|---|---|---|---|
| D1 | `src/health.ts:27-35` | `RETRY_MS{profile,auth,permission,config:5min,rateLimit:15min,network:1min,generic:5min}` | `health.retryMs` (required map; `null` = documented constant shown by `config --explain`) |
| D2 | `src/config.ts:137-153` | `DEFAULT_TIMING` (14 knobs) + `TIMING_MIN_MS` floors | `timing.*` required; floors stay as schema validation (documented, not behavior) |
| D3 | `src/config.ts:70-78,62-68,55-60,33-53` | `DEFAULT_WORKFLOW/LIMITS/RUN_LIMITS/PR_TRACKING/ENV_FILES` | init-templates + required sections; `loadProfile` deepMerge removed |
| D4 | `src/config.ts:92-159` | `DEFAULT_REPAIR_MUTABLE_PATHS/ALLOW_NEW_KEYS/STRATEGIES` + `NEVER_MUTABLE` regexes | `repair.*` required in config; `NEVER_MUTABLE` stays code (security floor, documented) |
| D5 | `src/scheduler.ts:111`, `src/orchestrator.ts` call sites | `drain 60s` default, `120s` waits, `pollSeconds*1000`, `truncate 120`, cache `10min`, `retryMs 5min`, rate-limit chunk | `loop.{drainMs,waitMs,truncLen,cacheMs}`, `timing.*` |
| D6 | `src/agent.ts:48-62,150-164` | `ROLE_TIMEOUT_KEY`, `45min` fallback, `resultMode ?? "file"`, `timeoutMs` chain, tail `20_000`, evidence slices `6000/4000` | `executor.{roleTimeouts,resultMode,timeoutMs,tailBytes,evidenceChars}` |

## E. Explicitly NOT config-driven (code stays, documented)

- `NEVER_MUTABLE` patterns (`config.ts:161-177`) — security floor; agent can never propose these paths even if allowlisted.
- Zod-shape guards / `assertResponseShape` mechanics — the *mechanism* stays code; the *expected shape* (`expect`, keys) is config.
- Regex *compilation* and endpoint *rendering* (`renderEndpoint`) — engine stays code; patterns/templates are config.
- `??`/`||` used for display strings (`(none)`, `""`) and pure null-safe traversal — not behavior; left alone.
- Validation floors (`pollSeconds>=10` etc.), file mode `600`, node `>=20` — schema/safety minima, documented in `docs/config.md`.
