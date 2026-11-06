import { randomUUID } from "node:crypto";
import type {
  AgentKey,
  AgentMe,
  AgentProfile,
  AgentSkillConfig,
  Escalation,
  Idea,
  InboxItem,
  Issue,
  OperationConfig,
  ProfileConfig,
  ResearchJob,
  Stake,
  TestVerdict,
  TransportConfig,
  WorkFeed,
  WorkItem,
  ApiContractStore,
  ProjectSummary
} from "./types.js";
import { contractKey, formatApiErrorDetails, recordRejected, repairApiBody, stripRejectedFields } from "./api-repair.js";
import { endpointVars, renderEndpoint } from "./ziki-endpoints.js";

export class ZikiError extends Error {
  status: number;
  body: unknown;
  method: string | null;
  path: string | null;
  cause: unknown;

  constructor(
    message: string,
    options: { status?: number; body?: unknown; method?: string | null; path?: string | null; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "ZikiError";
    this.status = options.status ?? 0;
    this.body = options.body ?? null;
    this.method = options.method ?? null;
    this.path = options.path ?? null;
    this.cause = options.cause ?? null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Guard against silent shape changes: an HTML login page, a moved endpoint
 * returning prose, or a restructured payload must fail loudly here instead of
 * flowing downstream as an empty-but-valid result.
 */
function assertResponseShape(
  method: string,
  pathname: string,
  status: number,
  data: unknown,
  expect: "feed" | "list" | "object",
  previewChars: number
): void {
  const items = (data as { items?: unknown } | null)?.items;
  const ok =
    expect === "object"
      ? typeof data === "object" && data !== null && !Array.isArray(data)
      : Array.isArray(items) || Array.isArray(data);
  if (ok) return;
  const preview =
    typeof data === "string" ? data.slice(0, previewChars) : JSON.stringify(data)?.slice(0, previewChars);
  throw new ZikiError(
    `${method} ${pathname} failed: unexpected response shape (expected ${expect}, got ${preview || "empty"})`,
    {
      status,
      body: { error: "unexpected_response_shape", expected: expect, preview: preview ?? null },
      method,
      path: pathname
    }
  );
}

function retryAfterMs(
  response: Response,
  attempt: number,
  maxMs: number,
  growthCapMs: number
): number {
  const retry = response.headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds)) return Math.min(maxMs, Math.max(0, seconds * 1000));
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return Math.min(maxMs, Math.max(0, date - Date.now()));
  }
  const reset = response.headers.get("ratelimit-reset");
  if (reset) {
    const value = Number(reset);
    if (Number.isFinite(value)) {
      const ms = value > 1e12 ? value - Date.now() : value * 1000 - Date.now();
      if (ms > 0) return Math.min(maxMs, ms);
    }
  }
  return Math.min(maxMs, growthCapMs, 1000 * 2 ** attempt);
}

export interface ApiRepairContext {
  method: string;
  path: string;
  status: number;
  body: unknown;
  errorBody: unknown;
  contractKey: string;
}

export interface ApiRepairResult {
  body?: unknown;
  abandon?: string;
}

export type ApiRepairHandler = (context: ApiRepairContext) => Promise<ApiRepairResult | null>;

/**
 * Value to send as the `platform` query parameter on Ziki list endpoints.
 * - `ziki.platformFilter` set → send it (category renames without touching identity).
 * - `ziki.platformFilter: null` → omit the parameter.
 * - absent → send `ziki.platform` (legacy behavior).
 */
export function apiPlatformFilter(profile: ProfileConfig): string | undefined {
  const override = profile.ziki.platformFilter;
  if (override === null) return undefined;
  if (typeof override === "string" && override.trim()) return override.trim();
  return profile.ziki.platform;
}

function requireTransportNumber(transport: TransportConfig, key: keyof TransportConfig): number {
  const value = transport[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`transport.${String(key)} must be a non-negative number (run \`auto-work migrate\`)`);
  }
  return value;
}

function requireTransportString(transport: TransportConfig, key: keyof TransportConfig): string {
  const value = transport[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`transport.${String(key)} must be a non-empty string (run \`auto-work migrate\`)`);
  }
  return value;
}

export class ZikiClient {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  projectSlug: string;
  orgSlug?: string | null;
  vars: Record<string, string>;
  endpoints: Record<string, Record<string, string>>;
  transport: TransportConfig;
  operations: Record<string, Record<string, OperationConfig>>;
  agentName: string;
  timeoutMs: number;
  contracts?: ApiContractStore;
  repair?: ApiRepairHandler;
  apiRepairPolicy?: { deterministicRetries?: number; agentRepairs?: number; statuses?: number[] };

  constructor(options: {
    baseUrl?: string;
    apiKey: string;
    projectId: string;
    projectSlug: string;
    orgSlug?: string | null;
    vars?: Record<string, string>;
    endpoints?: Record<string, Record<string, string>>;
    transport: TransportConfig;
    operations: Record<string, Record<string, OperationConfig>>;
    agentName: string;
    timeoutMs?: number;
    contracts?: ApiContractStore;
    repair?: ApiRepairHandler;
    apiRepairPolicy?: { deterministicRetries?: number; agentRepairs?: number; statuses?: number[] };
  }) {
    if (!options.baseUrl) throw new Error("ZikiClient requires baseUrl (run `auto-work migrate`)");
    if (!options.transport || typeof options.transport !== "object") {
      throw new Error("ZikiClient requires transport config (run `auto-work migrate`)");
    }
    if (!options.operations || typeof options.operations !== "object") {
      throw new Error("ZikiClient requires operations config (run `auto-work migrate`)");
    }
    if (!options.agentName) throw new Error("ZikiClient requires agentName");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.projectSlug = options.projectSlug;
    this.orgSlug = options.orgSlug ?? null;
    this.vars = { ...(options.vars ?? {}) };
    this.endpoints = options.endpoints ?? {};
    this.transport = options.transport;
    this.operations = options.operations;
    this.agentName = options.agentName;
    this.timeoutMs = options.timeoutMs ?? requireTransportNumber(options.transport, "defaultTimeoutMs");
    this.contracts = options.contracts;
    this.repair = options.repair;
    this.apiRepairPolicy = options.apiRepairPolicy;
  }

  /** Operation contract for group.name — throws unknown_operation when absent. */
  op(group: string, name: string): OperationConfig {
    const op = this.operations[group]?.[name];
    if (!op || typeof op !== "object") {
      throw new Error(
        `unknown operation: ${group}.${name} (not in operations config — update config or run migrate)`
      );
    }
    return op;
  }

  /**
   * Resolve a configured endpoint template into a path, interpolating
   * `{var}` placeholders from explicit params, configured vars, and identity
   * fields (projectId/projectSlug/orgSlug/platform). Throws on unknown or
   * missing required vars — a wrong but well-formed URL is worse than none.
   * No built-in fallback: unknown names fail loud so URL-shape changes
   * surface as repair proposals instead of silent wrong calls.
   */
  route(group: string, name: string, params: Record<string, string | number> = {}): string {
    const template = this.endpoints[group]?.[name];
    if (!template) {
      throw new Error(
        `unknown endpoint: ${group}.${name} (not in ziki.endpoints — update config or run migrate)`
      );
    }
    const vars: Record<string, string> = {
      ...endpointVars({
        vars: this.vars,
        projectId: this.projectId,
        projectSlug: this.projectSlug,
        orgSlug: this.orgSlug ?? undefined,
        platform: undefined
      })
    };
    for (const [key, value] of Object.entries(params)) {
      vars[key] = String(value);
    }
    return renderEndpoint(template, vars);
  }

  private url(pathname: string, query: Record<string, unknown> = {}): URL {
    const url = new URL(`${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** Policy knobs for the adaptive repair loop (apiRepair config section). */
  repairPolicy(): { deterministicRetries: number; agentRepairs: number; statuses: number[] } {
    const policy = this.apiRepairPolicy;
    const num = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    const statuses = Array.isArray(policy?.statuses)
      ? (policy.statuses as unknown[]).filter((entry): entry is number => typeof entry === "number")
      : [400, 422];
    return {
      deterministicRetries: num(policy?.deterministicRetries, 2),
      agentRepairs: num(policy?.agentRepairs, 1),
      statuses: statuses.length ? statuses : [400, 422]
    };
  }

  async request<T = any>(
    method: string,
    pathname: string,
    options: {
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      idempotencyKey?: string;
      raw?: boolean;
      retries?: number;
      timeoutMs?: number;
      maxRetryAfterMs?: number;
      /**
       * Expected shape of a successful response. Mismatches throw instead of
       * being swallowed downstream (e.g. an HTML login page where a JSON feed
       * was expected). Keep narrow: only set where the shape is contractual.
       */
      expect?: "feed" | "list" | "object";
    } = {}
  ): Promise<T> {
    const key = contractKey(method, pathname);
    const policy = this.repairPolicy();
    let body = stripRejectedFields(options.body, this.contracts?.[key]?.rejected ?? []);
    let deterministicRepairs = 0;
    let agentRepairs = 0;

    for (;;) {
      try {
        return await this.requestOnce<T>(method, pathname, { ...options, body });
      } catch (error) {
        if (!(error instanceof ZikiError)) throw error;

        if (deterministicRepairs < policy.deterministicRetries) {
          const repaired = repairApiBody(body, error.body);
          if (repaired?.changed) {
            body = repaired.body;
            if (this.contracts) recordRejected(this.contracts, key, repaired.rejected);
            deterministicRepairs += 1;
            continue;
          }
        }

        if (agentRepairs < policy.agentRepairs && this.repair && body !== undefined && policy.statuses.includes(error.status)) {
          agentRepairs += 1;
          let repaired: ApiRepairResult | null = null;
          try {
            repaired = await this.repair({
              method,
              path: pathname,
              status: error.status,
              body,
              errorBody: error.body,
              contractKey: key
            });
          } catch {
            repaired = null;
          }
          if (repaired?.body !== undefined) {
            body = repaired.body;
            continue;
          }
          if (repaired?.abandon) {
            throw new ZikiError(`${error.message} (repair abandoned: ${repaired.abandon})`, {
              status: error.status,
              body: error.body,
              method,
              path: pathname
            });
          }
        }

        throw error;
      }
    }
  }

  private async requestOnce<T = any>(
    method: string,
    pathname: string,
    options: {
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      idempotencyKey?: string;
      raw?: boolean;
      retries?: number;
      timeoutMs?: number;
      maxRetryAfterMs?: number;
      expect?: "feed" | "list" | "object";
    } = {}
  ): Promise<T> {
    const url = this.url(pathname, options.query ?? {});
    const transport = this.transport;
    const retries = options.retries ?? requireTransportNumber(transport, "defaultRetries");
    const retryCap = requireTransportNumber(transport, "backoffCapMs");
    const growthCap = requireTransportNumber(transport, "retryGrowthCapMs");
    const previewChars = requireTransportNumber(transport, "previewChars");
    const authScheme = requireTransportString(transport, "authScheme");
    const userAgent = requireTransportString(transport, "userAgent");
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= retries) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `${authScheme} ${this.apiKey}`,
            Accept: "application/json",
            "User-Agent": userAgent,
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
            ...(options.headers ?? {})
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)
        });

        if (response.status === 304 && options.raw) {
          return { data: null, response } as T;
        }

        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await sleep(retryAfterMs(response, attempt, options.maxRetryAfterMs ?? retryCap, growthCap));
          attempt += 1;
          continue;
        }

        const text = await response.text();
        let data: unknown = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }

        if (!response.ok) {
          const record = data as Record<string, unknown> | null;
          const message = String(record?.message ?? record?.error ?? `HTTP ${response.status}`);
          throw new ZikiError(`${method} ${pathname} failed: ${message}${formatApiErrorDetails(data)}`, {
            status: response.status,
            body: data,
            method,
            path: pathname
          });
        }

        if (options.expect) {
          assertResponseShape(method, pathname, response.status, data, options.expect, previewChars);
        }

        if (options.raw) return { data, response } as T;
        return data as T;
      } catch (error) {
        lastError = error;
        if (error instanceof ZikiError) throw error;
        if (attempt >= retries) break;
        await sleep(Math.min(growthCap, 1000 * 2 ** attempt));
        attempt += 1;
      }
    }

    throw new ZikiError(
      `${method} ${pathname} failed: ${lastError instanceof Error ? lastError.message : "network error"}`,
      { method, path: pathname, cause: lastError }
    );
  }

  get<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T> {
    return this.request<T>("GET", pathname, options);
  }

  post<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T> {
    return this.request<T>("POST", pathname, options);
  }

  patch<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T> {
    return this.request<T>("PATCH", pathname, options);
  }

  put<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T> {
    return this.request<T>("PUT", pathname, options);
  }

  del<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T> {
    return this.request<T>("DELETE", pathname, options);
  }

  /**
   * Config-driven operation call. Method, expected shape, timeout and retry
   * budget come from `operations.<group>.<name>` — a Ziki method change,
   * renamed payload or new pagination policy is a config patch, never code.
   * Thin typed wrappers below supply only field data (the loop's own inputs).
   */
  invoke<T = any>(
    group: string,
    name: string,
    options: {
      params?: Record<string, string | number>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      raw?: boolean;
      timeoutMs?: number;
      retries?: number;
      maxRetryAfterMs?: number;
      idempotencyKey?: string;
    } = {}
  ): Promise<T> {
    const op = this.op(group, name);
    const method = op.method;
    if (!method) throw new Error(`operation ${group}.${name} has no method (run \`auto-work migrate\`)`);
    return this.request<T>(method, this.route(group, op.route ?? name, options.params), {
      query: options.query,
      body: options.body,
      headers: options.headers,
      raw: options.raw,
      timeoutMs: options.timeoutMs ?? op.timeoutMs,
      retries: options.retries ?? op.retries,
      maxRetryAfterMs: options.maxRetryAfterMs,
      idempotencyKey: options.idempotencyKey,
      expect: op.expect
    });
  }

  /**
   * Config-driven cursor pagination. Keys, page size and page/item caps come
   * from `operations.<group>.<name>.pagination`.
   */
  async listAllOp<T = any>(
    group: string,
    name: string,
    options: {
      params?: Record<string, string | number>;
      query?: Record<string, unknown>;
      max?: number;
    } = {}
  ): Promise<T[]> {
    const op = this.op(group, name);
    const pagination = op.pagination;
    if (!pagination) {
      throw new Error(`operation ${group}.${name} has no pagination config (add operations.${group}.${name}.pagination)`);
    }
    const where = `operations.${group}.${name}.pagination`;
    for (const key of ["limitKey", "cursorKey", "itemsKey", "nextCursorKey", "defaultLimit", "maxPages", "maxItems"] as const) {
      if (pagination[key] === undefined) {
        throw new Error(`operation ${group}.${name} is missing ${where}.${key} (run \`auto-work migrate\`)`);
      }
    }
    const limitKey = pagination.limitKey as string;
    const cursorKey = pagination.cursorKey as string;
    const itemsKey = pagination.itemsKey as string;
    const nextCursorKey = pagination.nextCursorKey as string;
    const defaultLimit = pagination.defaultLimit as number;
    const maxPages = pagination.maxPages as number;
    const maxItems = pagination.maxItems as number;
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.invoke<{ [key: string]: unknown }>(group, name, {
        params: options.params,
        query: { ...options.query, [limitKey]: defaultLimit, [cursorKey]: cursor }
      });
      const batch = (data as Record<string, unknown>)[itemsKey];
      if (Array.isArray(batch)) items.push(...(batch as T[]));
      cursor = (data as Record<string, unknown>)[nextCursorKey] as string | undefined;
      if (!cursor || items.length >= (options.max ?? maxItems)) break;
    }
    return items;
  }

  me(): Promise<AgentMe> {
    return this.invoke("agents", "me");
  }

  updateProfile(input: { username?: string; tagline?: string | null; about?: string | null }): Promise<AgentProfile> {
    return this.invoke("agents", "updateMe", { body: input });
  }

  listSkills(): Promise<{ skills?: AgentSkillConfig[] }> {
    return this.invoke("agents", "skills");
  }

  setSkills(skills: AgentSkillConfig[]): Promise<{ skills?: AgentSkillConfig[] }> {
    return this.invoke("agents", "putSkills", { body: { skills } });
  }

  setSkill(tag: string, input: { summary: string; description: string }): Promise<{ skills?: AgentSkillConfig[] }> {
    return this.invoke("agents", "skill", { params: { tag: encodeURIComponent(tag) }, body: input });
  }

  removeSkill(tag: string): Promise<any> {
    return this.invoke("agents", "deleteSkill", { params: { tag: encodeURIComponent(tag) } });
  }

  skillTags(): Promise<{ tags?: Array<{ name: string; slug: string; agents: number }> }> {
    return this.invoke("agents", "skillTags");
  }

  async setPicture(file: string): Promise<{ picture_url?: string }> {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(file);
    const name = file.split(/[\\/]/).pop() || "picture";
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    const op = this.op("agents", "picture");
    const picturePath = this.route("agents", "picture");
    const response = await fetch(`${this.baseUrl}${picturePath}`, {
      method: op.method ?? "PUT",
      headers: {
        Authorization: `${requireTransportString(this.transport, "authScheme")} ${this.apiKey}`,
        Accept: "application/json",
        "User-Agent": requireTransportString(this.transport, "userAgent")
      },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as { picture_url?: string }) : {};
    if (!response.ok) {
      throw new ZikiError(`${op.method ?? "PUT"} ${picturePath} failed: HTTP ${response.status}`, {
        status: response.status,
        body: data,
        method: op.method ?? "PUT",
        path: picturePath
      });
    }
    return data;
  }

  removePicture(): Promise<any> {
    return this.invoke("agents", "deletePicture");
  }

  listAgents(tag?: string): Promise<{ agents?: AgentProfile[] }> {
    return this.invoke("agents", "list", { query: { tag } });
  }

  getAgent(username: string): Promise<AgentProfile> {
    return this.invoke("agents", "get", { params: { username: encodeURIComponent(username) } });
  }

  platforms(): Promise<any> {
    return this.invoke("platforms", "list");
  }

  project(): Promise<any> {
    return this.invoke("projects", "get", { params: { project: this.projectId } });
  }

  /** Read one project by id (used to verify rotation targets and parse workUrl). */
  readProject(projectId: string): Promise<ProjectSummary & { workUrl?: string }> {
    return this.invoke("projects", "get", { params: { project: projectId } });
  }

  /**
   * Every project in the agent's tenant — the recovery endpoint for a retired
   * projectId. Needs no project scope, so it works while project routes 404.
   */
  listProjects(): Promise<{ items: ProjectSummary[] }> {
    return this.invoke("projects", "list");
  }

  async work(options: { etag?: string } = {}): Promise<{ notModified: boolean; data?: WorkFeed; etag?: string }> {
    const op = this.op("work", "feed");
    const result = await this.request<{ data: WorkFeed | null; response: Response }>(
      op.method ?? "GET",
      this.route("work", "feed"),
      {
        headers: options.etag ? { "If-None-Match": options.etag } : {},
        raw: true,
        expect: op.expect
      }
    );
    if (result.response.status === 304) {
      return { notModified: true, etag: result.response.headers.get("etag") || options.etag };
    }
    return {
      notModified: false,
      data: result.data ?? undefined,
      etag: result.response.headers.get("etag") || undefined
    };
  }

  listIssues(options: { platform?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<any> {
    const limit = options.limit ?? this.op("issues", "list").pagination?.defaultLimit;
    return this.invoke("issues", "list", {
      query: {
        projectId: this.projectId,
        platform: options.platform,
        status: options.status,
        limit,
        cursor: options.cursor
      }
    });
  }

  async listAllIssues(options: { platform?: string; status?: string; max?: number } = {}): Promise<Issue[]> {
    return this.listAllOp<Issue>("issues", "list", {
      query: { projectId: this.projectId, platform: options.platform, status: options.status },
      max: options.max
    });
  }

  counts(): Promise<any> {
    return this.invoke("issues", "counts", { query: { projectId: this.projectId } });
  }

  getIssue(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "get", { params: { issue: idOrNumber }, query: { projectId: this.projectId } });
  }

  comments(idOrNumber: string | number, options: { limit?: number; cursor?: string } = {}): Promise<any> {
    const limit = options.limit ?? this.op("issues", "comments").pagination?.defaultLimit;
    return this.invoke("issues", "comments", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId, limit, cursor: options.cursor }
    });
  }

  comment(idOrNumber: string | number, body: Record<string, unknown>): Promise<any> {
    return this.invoke("issues", "postComment", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body
    });
  }

  upvoteComment(commentId: string): Promise<any> {
    return this.invoke("comments", "votes", {
      params: { comment: commentId },
      query: { projectId: this.projectId }
    });
  }

  createIdea(input: {
    title: string;
    summary: string;
    description: string;
    areaId?: string;
    typeId?: string;
    proofLinks?: string;
    attachmentIds?: string[];
    acknowledgeSimilar?: boolean;
    alreadyVetted?: boolean;
    vettedNote?: string;
    idempotencyKey?: string;
  }): Promise<any> {
    return this.invoke("ideas", "create", {
      query: { projectId: this.projectId },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      body: {
        title: input.title,
        summary: input.summary,
        description: input.description,
        areaId: input.areaId,
        typeId: input.typeId,
        proofLinks: input.proofLinks,
        attachmentIds: input.attachmentIds,
        acknowledgeSimilar: input.acknowledgeSimilar,
        alreadyVetted: input.alreadyVetted,
        vettedNote: input.vettedNote
      }
    });
  }

  listIdeas(options: { status?: string; convertible?: boolean; platform?: string; limit?: number; cursor?: string } = {}): Promise<any> {
    const limit = options.limit ?? this.op("ideas", "list").pagination?.defaultLimit;
    return this.invoke("ideas", "list", {
      query: {
        projectId: this.projectId,
        status: options.status,
        convertible: options.convertible,
        platform: options.platform,
        limit,
        cursor: options.cursor
      }
    });
  }

  async listAllIdeas(options: { platform?: string; status?: string; max?: number } = {}): Promise<Idea[]> {
    return this.listAllOp<Idea>("ideas", "list", {
      query: { projectId: this.projectId, platform: options.platform, status: options.status },
      max: options.max
    });
  }

  getIdea(idOrNumber: string | number): Promise<any> {
    return this.invoke("ideas", "get", { params: { idea: idOrNumber }, query: { projectId: this.projectId } });
  }

  ideaVerdicts(idOrNumber: string | number): Promise<any> {
    return this.invoke("ideas", "listVerdicts", {
      params: { idea: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  giveIdeaVerdict(
    idOrNumber: string | number,
    input: { opinion: "good" | "bad" | "neutral"; votes?: number; summary: string; description: string }
  ): Promise<any> {
    return this.invoke("ideas", "verdicts", {
      params: { idea: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  convertIdea(idOrNumber: string | number): Promise<any> {
    return this.invoke("ideas", "convert", {
      params: { idea: idOrNumber },
      query: { projectId: this.projectId },
      body: {}
    });
  }

  rejectIdea(idOrNumber: string | number, body: Record<string, unknown> = {}): Promise<any> {
    return this.invoke("ideas", "reject", {
      params: { idea: idOrNumber },
      query: { projectId: this.projectId },
      body
    });
  }

  archiveIdea(idOrNumber: string | number, body: Record<string, unknown> = {}): Promise<any> {
    return this.invoke("ideas", "archive", {
      params: { idea: idOrNumber },
      query: { projectId: this.projectId },
      body
    });
  }

  categorizeIdea(idOrNumber: string | number, input: { platform: string; reason?: string }): Promise<any> {
    return this.invoke("ideas", "platform", {
      params: { idea: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  confirmIssue(
    idOrNumber: string | number,
    input: {
      verdict: "confirm" | "reject" | "neutral";
      summary: string;
      description: string;
      files?: Array<{ path: string; lines?: string }>;
      duplicateOfId?: string | number;
      attachmentIds?: string[];
    }
  ): Promise<any> {
    return this.invoke("issues", "confirmations", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  openIssue(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "open", { params: { issue: idOrNumber }, query: { projectId: this.projectId } });
  }

  bid(idOrNumber: string | number, input: { summary: string; description: string }): Promise<any> {
    return this.invoke("issues", "bid", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  withdrawBid(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "withdrawBid", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  listBids(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "listBids", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  awardBid(bidId: string): Promise<any> {
    return this.invoke("bids", "award", { params: { bid: bidId }, query: { projectId: this.projectId } });
  }

  voteBid(bidId: string): Promise<any> {
    return this.invoke("bids", "votes", { params: { bid: bidId }, query: { projectId: this.projectId } });
  }

  stake(idOrNumber: string | number, input: { summary: string; description: string }): Promise<any> {
    return this.invoke("issues", "stake", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  acceptOffer(offerId: string): Promise<any> {
    return this.invoke("offers", "accept", { params: { offer: offerId }, query: { projectId: this.projectId } });
  }

  heartbeat(
    idOrNumber: string | number,
    options: { timeoutMs?: number; retries?: number; maxRetryAfterMs?: number } = {}
  ): Promise<any> {
    return this.invoke("issues", "heartbeat", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      ...options
    });
  }

  extend(idOrNumber: string | number, reason: string): Promise<any> {
    return this.invoke("issues", "extend", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: { reason }
    });
  }

  release(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "release", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  reclaim(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "reclaim", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  markImportant(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "importance", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  abandonVote(idOrNumber: string | number, summary: string): Promise<any> {
    return this.invoke("issues", "abandonVotes", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: { summary }
    });
  }

  suggestClose(
    idOrNumber: string | number,
    input: {
      reason: string;
      evidence: string;
      summary: string;
      description?: string;
      duplicateOf?: number | string;
    }
  ): Promise<any> {
    return this.invoke("issues", "closeSuggestions", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  closeIssue(
    idOrNumber: string | number,
    input: { reason: string; evidence: string; duplicateOf?: number | string }
  ): Promise<any> {
    return this.invoke("issues", "close", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  stakeIssue(idOrNumber: string | number, input: { summary: string; description: string }): Promise<{ stake?: Stake }> {
    return this.invoke("issues", "stake", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  listStakes(idOrNumber: string | number): Promise<{ stakes?: Stake[] }> {
    return this.invoke("issues", "listStakes", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  refreshStake(stakeId: string): Promise<{ stake?: Stake }> {
    return this.invoke("stakes", "refresh", {
      params: { stake: stakeId },
      query: { projectId: this.projectId }
    });
  }

  voteStake(stakeId: string): Promise<any> {
    return this.invoke("stakes", "votes", {
      params: { stake: stakeId },
      query: { projectId: this.projectId }
    });
  }

  acceptReviewOffer(offerId: string): Promise<any> {
    return this.invoke("reviews", "accept", { params: { offer: offerId }, query: { projectId: this.projectId } });
  }

  acceptJobReview(offerId: string): Promise<any> {
    return this.invoke("jobs", "acceptReview", {
      params: { offer: offerId },
      query: { projectId: this.projectId }
    });
  }

  getJob(jobId: string): Promise<ResearchJob> {
    return this.invoke("jobs", "get", { params: { job: jobId }, query: { projectId: this.projectId } });
  }

  submitJob(jobId: string, data: unknown): Promise<any> {
    return this.invoke("jobs", "submissions", {
      params: { job: jobId },
      query: { projectId: this.projectId },
      body: { data }
    });
  }

  reviewJobSubmission(
    submissionId: string,
    input: { verdict: "accept" | "reject"; notes?: string }
  ): Promise<any> {
    return this.invoke("jobs", "submitReview", {
      params: { submission: submissionId },
      query: { projectId: this.projectId },
      body: input
    });
  }

  repairPullRequest(idOrNumber: string | number, pullRequestUrl?: string): Promise<any> {
    return this.invoke("issues", "pullRequest", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: pullRequestUrl ? { pullRequestUrl } : {}
    });
  }

  deliver(
    idOrNumber: string | number,
    input: {
      pullRequestUrl: string;
      summary: string;
      description: string;
      screenshots?: string[];
      testResults?: string;
      headSha?: string;
    }
  ): Promise<any> {
    return this.invoke("issues", "delivery", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  delivery(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "getDelivery", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  reportPrStatus(idOrNumber: string | number, report: Record<string, unknown>): Promise<any> {
    return this.invoke("issues", "pullRequestStatus", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: report
    });
  }

  submitTestResult(
    idOrNumber: string | number,
    input: {
      goodToMerge: boolean;
      summary: string;
      description: string;
      files?: Array<{ path: string; lines?: string }>;
      headSha?: string;
    }
  ): Promise<any> {
    return this.invoke("issues", "testResults", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  listTestResults(idOrNumber: string | number): Promise<{ verdicts?: TestVerdict[] }> {
    return this.invoke("issues", "getTestResults", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  mergeReview(
    idOrNumber: string | number,
    input: { verdict: "accept" | "reject"; summary: string; description: string }
  ): Promise<any> {
    return this.invoke("issues", "merge", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  listMergeReviews(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "mergeReviews", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  reportDeployment(idOrNumber: string | number, input: { environment: "dev" | "staging" | "prod"; note: string }): Promise<any> {
    return this.invoke("issues", "deployment", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  resolveIssue(idOrNumber: string | number, pullRequestUrl?: string): Promise<any> {
    return this.invoke("issues", "resolve", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: pullRequestUrl ? { pullRequestUrl } : {}
    });
  }

  estimateReward(idOrNumber: string | number, input: { value: number; reason: string }): Promise<any> {
    return this.invoke("issues", "reward", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  getReward(idOrNumber: string | number): Promise<any> {
    return this.invoke("issues", "getReward", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId }
    });
  }

  categorizeIssue(idOrNumber: string | number, input: { platform: string; reason?: string }): Promise<any> {
    return this.invoke("issues", "platform", {
      params: { issue: idOrNumber },
      query: { projectId: this.projectId },
      body: input
    });
  }

  escalate(input: { body: string; type?: string; bugId?: string }): Promise<{ escalation?: Escalation }> {
    return this.invoke("escalations", "create", { body: input });
  }

  getEscalation(id: string): Promise<{ escalation?: Escalation }> {
    return this.invoke("escalations", "get", { params: { id } });
  }

  askQuestion(input: { body: string; bugId?: string }): Promise<any> {
    return this.invoke("questions", "create", { body: input });
  }

  getQuestion(id: string): Promise<any> {
    return this.invoke("questions", "get", { params: { id } });
  }

  inbox(options: { unread?: boolean; cursor?: string; wait?: number } = {}): Promise<{ items?: InboxItem[] }> {
    return this.invoke("inbox", "list", {
      query: { unread: options.unread === false ? undefined : 1, cursor: options.cursor, wait: options.wait }
    });
  }

  markInboxRead(ids: string[]): Promise<any> {
    return this.invoke("inbox", "read", { body: { ids } });
  }

  completeOwnerRequest(id: string): Promise<any> {
    return this.invoke("agents", "dismissRequest", { params: { id } });
  }

  projectNotes(): Promise<any> {
    return this.invoke("projects", "notes", { params: { project: this.projectId } });
  }

  projectNotesComments(options: { status?: string } = {}): Promise<any> {
    return this.invoke("projects", "notesComments", {
      params: { project: this.projectId },
      query: { status: options.status }
    });
  }

  addProjectNoteComment(input: { body: string; parentId?: string }): Promise<any> {
    return this.invoke("projects", "postNotesComment", {
      params: { project: this.projectId },
      body: input
    });
  }

  voteNoteComment(commentId: string, direction = 1): Promise<any> {
    const suffix = direction >= 0 ? "upvote" : "downvote";
    return this.invoke("projects", "noteComment", {
      params: { project: this.projectId, comment: commentId, action: suffix }
    });
  }

  agentNotes(): Promise<{ items?: Array<{ id: string; body: string; createdAt: string }> }> {
    return this.invoke("projects", "myNotes", { params: { project: this.projectId } });
  }

  addAgentNote(body: string): Promise<any> {
    return this.invoke("projects", "postMyNote", {
      params: { project: this.projectId },
      body: { body }
    });
  }

  editAgentNote(noteId: string, body: string): Promise<any> {
    return this.invoke("projects", "myNote", {
      params: { project: this.projectId, note: noteId },
      body: { body }
    });
  }

  deleteAgentNote(noteId: string): Promise<any> {
    return this.invoke("projects", "deleteMyNote", {
      params: { project: this.projectId, note: noteId }
    });
  }

  mistakes(options: { limit?: number } = {}): Promise<{ mistakes?: unknown[] }> {
    const limit = options.limit ?? this.op("projects", "mistakes").pagination?.defaultLimit;
    return this.invoke("projects", "mistakes", {
      params: { project: this.projectId },
      query: { limit }
    });
  }

  history(options: { kind?: string; limit?: number; cursor?: string } = {}): Promise<any> {
    const limit = options.limit ?? this.op("agents", "history").pagination?.defaultLimit;
    return this.invoke("agents", "history", {
      query: { kind: options.kind, limit, cursor: options.cursor }
    });
  }

  points(): Promise<any> {
    return this.invoke("agents", "points");
  }
}

export function clientForAgent(
  agent: AgentKey,
  profile: ProfileConfig,
  options: {
    contracts?: ApiContractStore;
    repair?: ApiRepairHandler;
    apiRepairPolicy?: { deterministicRetries?: number; agentRepairs?: number; statuses?: number[] };
  } = {}
): ZikiClient {
  return new ZikiClient({
    baseUrl: profile.ziki.baseUrl,
    apiKey: agent.key,
    projectId: profile.ziki.projectId,
    projectSlug: profile.ziki.projectSlug,
    orgSlug: profile.ziki.orgSlug ?? null,
    vars: profile.ziki.vars,
    endpoints: profile.ziki.endpoints,
    transport: profile.transport ?? {},
    operations: profile.operations ?? {},
    agentName: agent.name,
    contracts: options.contracts,
    repair: options.repair,
    apiRepairPolicy: options.apiRepairPolicy ?? profile.apiRepair
  });
}

export function normalizeIssue(data: any): Issue | null {
  return (data?.issue ?? data ?? null) as Issue | null;
}

export function normalizeIdea(data: any): Idea | null {
  return (data?.idea ?? data ?? null) as Idea | null;
}

export function normalizeWorkItem(item: WorkItem): WorkItem {
  return item;
}
