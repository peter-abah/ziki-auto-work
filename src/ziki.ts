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
  ProfileConfig,
  ResearchJob,
  Stake,
  TestVerdict,
  WorkFeed,
  WorkItem,
  ApiContractStore,
  ProjectSummary
} from "./types.js";
import { contractKey, formatApiErrorDetails, recordRejected, repairApiBody, stripRejectedFields } from "./api-repair.js";

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

function retryAfterMs(response: Response, attempt: number, maxMs = Infinity): number {
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
  return Math.min(maxMs, 60_000, 1000 * 2 ** attempt);
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

export class ZikiClient {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  projectSlug: string;
  agentName: string;
  timeoutMs: number;
  contracts?: ApiContractStore;
  repair?: ApiRepairHandler;

  constructor(options: {
    baseUrl?: string;
    apiKey: string;
    projectId: string;
    projectSlug: string;
    agentName?: string;
    timeoutMs?: number;
    contracts?: ApiContractStore;
    repair?: ApiRepairHandler;
  }) {
    this.baseUrl = (options.baseUrl ?? "https://ziki.dev").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.projectSlug = options.projectSlug;
    this.agentName = options.agentName ?? "agent";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.contracts = options.contracts;
    this.repair = options.repair;
  }

  private url(pathname: string, query: Record<string, unknown> = {}): URL {
    const url = new URL(`${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url;
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
    } = {}
  ): Promise<T> {
    const key = contractKey(method, pathname);
    let body = stripRejectedFields(options.body, this.contracts?.[key]?.rejected ?? []);
    let deterministicRepairs = 0;
    let agentRepairs = 0;

    for (;;) {
      try {
        return await this.requestOnce<T>(method, pathname, { ...options, body });
      } catch (error) {
        if (!(error instanceof ZikiError)) throw error;

        if (deterministicRepairs < 2) {
          const repaired = repairApiBody(body, error.body);
          if (repaired?.changed) {
            body = repaired.body;
            if (this.contracts) recordRejected(this.contracts, key, repaired.rejected);
            deterministicRepairs += 1;
            continue;
          }
        }

        if (agentRepairs < 1 && this.repair && body !== undefined && [400, 422].includes(error.status)) {
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
    } = {}
  ): Promise<T> {
    const url = this.url(pathname, options.query ?? {});
    const retries = options.retries ?? 3;
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= retries) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            "User-Agent": "ziki-auto-work/0.1",
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
          await sleep(retryAfterMs(response, attempt, options.maxRetryAfterMs ?? Infinity));
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

        if (options.raw) return { data, response } as T;
        return data as T;
      } catch (error) {
        lastError = error;
        if (error instanceof ZikiError) throw error;
        if (attempt >= retries) break;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
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

  me(): Promise<AgentMe> {
    return this.get("/api/v1/agents/me");
  }

  updateProfile(input: { username?: string; tagline?: string | null; about?: string | null }): Promise<AgentProfile> {
    return this.patch("/api/v1/agents/me", { body: input });
  }

  listSkills(): Promise<{ skills?: AgentSkillConfig[] }> {
    return this.get("/api/v1/agents/me/skills");
  }

  setSkills(skills: AgentSkillConfig[]): Promise<{ skills?: AgentSkillConfig[] }> {
    return this.put("/api/v1/agents/me/skills", { body: { skills } });
  }

  setSkill(tag: string, input: { summary: string; description: string }): Promise<{ skills?: AgentSkillConfig[] }> {
    return this.put(`/api/v1/agents/me/skills/${encodeURIComponent(tag)}`, { body: input });
  }

  removeSkill(tag: string): Promise<any> {
    return this.del(`/api/v1/agents/me/skills/${encodeURIComponent(tag)}`);
  }

  skillTags(): Promise<{ tags?: Array<{ name: string; slug: string; agents: number }> }> {
    return this.get("/api/v1/skill-tags");
  }

  async setPicture(file: string): Promise<{ picture_url?: string }> {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(file);
    const name = file.split(/[\\/]/).pop() || "picture";
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    const response = await fetch(`${this.baseUrl}/api/v1/agents/me/picture`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as { picture_url?: string }) : {};
    if (!response.ok) {
      throw new ZikiError(`PUT /api/v1/agents/me/picture failed: HTTP ${response.status}`, {
        status: response.status,
        body: data,
        method: "PUT",
        path: "/api/v1/agents/me/picture"
      });
    }
    return data;
  }

  removePicture(): Promise<any> {
    return this.del("/api/v1/agents/me/picture");
  }

  listAgents(tag?: string): Promise<{ agents?: AgentProfile[] }> {
    return this.get("/api/v1/agents", { query: { tag } });
  }

  getAgent(username: string): Promise<AgentProfile> {
    return this.get(`/api/v1/agents/${encodeURIComponent(username)}`);
  }

  platforms(): Promise<any> {
    return this.get("/api/v1/platforms");
  }

  project(): Promise<any> {
    return this.get(`/api/v1/projects/${this.projectId}`);
  }

  /**
   * Every project in the agent's tenant — the recovery endpoint for a retired
   * projectId. Needs no project scope, so it works while project routes 404.
   */
  listProjects(): Promise<{ items: ProjectSummary[] }> {
    return this.get("/api/v1/projects");
  }

  async work(options: { etag?: string } = {}): Promise<{ notModified: boolean; data?: WorkFeed; etag?: string }> {
    const result = await this.request<{ data: WorkFeed | null; response: Response }>("GET", `/${this.projectSlug}/work`, {
      headers: options.etag ? { "If-None-Match": options.etag } : {},
      raw: true
    });
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
    return this.get("/api/v1/issues", {
      query: {
        projectId: this.projectId,
        platform: options.platform,
        status: options.status,
        limit: options.limit ?? 100,
        cursor: options.cursor
      }
    });
  }

  async listAllIssues(options: { platform?: string; status?: string; max?: number } = {}): Promise<Issue[]> {
    const items: Issue[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.listIssues({ ...options, limit: 100, cursor });
      items.push(...(data.items ?? []));
      cursor = data.nextCursor ?? undefined;
      if (!cursor || items.length >= (options.max ?? 600)) break;
    }
    return items;
  }

  counts(): Promise<any> {
    return this.get("/api/v1/issues/counts", { query: { projectId: this.projectId } });
  }

  getIssue(idOrNumber: string | number): Promise<any> {
    return this.get(`/api/v1/issues/${idOrNumber}`, { query: { projectId: this.projectId } });
  }

  comments(idOrNumber: string | number, options: { limit?: number; cursor?: string } = {}): Promise<any> {
    return this.get(`/api/v1/issues/${idOrNumber}/comments`, {
      query: { projectId: this.projectId, limit: options.limit ?? 100, cursor: options.cursor }
    });
  }

  comment(idOrNumber: string | number, body: Record<string, unknown>): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/comments`, {
      query: { projectId: this.projectId },
      body
    });
  }

  upvoteComment(commentId: string): Promise<any> {
    return this.post(`/api/v1/comments/${commentId}/votes`, { query: { projectId: this.projectId } });
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
    return this.post("/api/v1/ideas", {
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
    return this.get("/api/v1/ideas", {
      query: {
        projectId: this.projectId,
        status: options.status,
        convertible: options.convertible,
        platform: options.platform,
        limit: options.limit ?? 100,
        cursor: options.cursor
      }
    });
  }

  async listAllIdeas(options: { platform?: string; status?: string; max?: number } = {}): Promise<Idea[]> {
    const items: Idea[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.listIdeas({ ...options, limit: 100, cursor });
      items.push(...(data.items ?? []));
      cursor = data.nextCursor ?? undefined;
      if (!cursor || items.length >= (options.max ?? 600)) break;
    }
    return items;
  }

  getIdea(idOrNumber: string | number): Promise<any> {
    return this.get(`/api/v1/ideas/${idOrNumber}`, { query: { projectId: this.projectId } });
  }

  ideaVerdicts(idOrNumber: string | number): Promise<any> {
    return this.get(`/api/v1/ideas/${idOrNumber}/verdicts`, { query: { projectId: this.projectId } });
  }

  giveIdeaVerdict(
    idOrNumber: string | number,
    input: { opinion: "good" | "bad" | "neutral"; votes?: number; summary: string; description: string }
  ): Promise<any> {
    return this.post(`/api/v1/ideas/${idOrNumber}/verdicts`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  convertIdea(idOrNumber: string | number): Promise<any> {
    return this.post(`/api/v1/ideas/${idOrNumber}/convert`, { query: { projectId: this.projectId }, body: {} });
  }

  rejectIdea(idOrNumber: string | number, body: Record<string, unknown> = {}): Promise<any> {
    return this.post(`/api/v1/ideas/${idOrNumber}/reject`, { query: { projectId: this.projectId }, body });
  }

  archiveIdea(idOrNumber: string | number, body: Record<string, unknown> = {}): Promise<any> {
    return this.post(`/api/v1/ideas/${idOrNumber}/archive`, { query: { projectId: this.projectId }, body });
  }

  categorizeIdea(idOrNumber: string | number, input: { platform: string; reason?: string }): Promise<any> {
    return this.put(`/api/v1/ideas/${idOrNumber}/platform`, {
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
    return this.post(`/api/v1/issues/${idOrNumber}/confirmations`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  openIssue(idOrNumber: string | number): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/open`, { query: { projectId: this.projectId } });
  }

  bid(idOrNumber: string | number, input: { summary: string; description: string }): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/bid`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  withdrawBid(idOrNumber: string | number): Promise<any> {
    return this.del(`/api/v1/issues/${idOrNumber}/bid`, { query: { projectId: this.projectId } });
  }

  listBids(idOrNumber: string | number): Promise<any> {
    return this.get(`/api/v1/issues/${idOrNumber}/bid`, { query: { projectId: this.projectId } });
  }

  awardBid(bidId: string): Promise<any> {
    return this.post(`/api/v1/bids/${bidId}/award`, { query: { projectId: this.projectId } });
  }

  voteBid(bidId: string): Promise<any> {
    return this.post(`/api/v1/bids/${bidId}/votes`, { query: { projectId: this.projectId } });
  }

  stake(idOrNumber: string | number, input: { summary: string; description: string }): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/stake`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  acceptOffer(offerId: string): Promise<any> {
    return this.post(`/api/v1/offers/${offerId}/accept`, { query: { projectId: this.projectId } });
  }

  heartbeat(
    idOrNumber: string | number,
    options: { timeoutMs?: number; retries?: number; maxRetryAfterMs?: number } = {}
  ): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/heartbeat`, {
      query: { projectId: this.projectId },
      ...options
    });
  }

  extend(idOrNumber: string | number, reason: string): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/extend`, {
      query: { projectId: this.projectId },
      body: { reason }
    });
  }

  release(idOrNumber: string | number): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/release`, { query: { projectId: this.projectId } });
  }

  reclaim(idOrNumber: string | number): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/reclaim`, { query: { projectId: this.projectId } });
  }

  markImportant(idOrNumber: string | number): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/importance`, { query: { projectId: this.projectId } });
  }

  abandonVote(idOrNumber: string | number, summary: string): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/abandon-votes`, {
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
    return this.post(`/api/v1/issues/${idOrNumber}/close-suggestions`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  closeIssue(
    idOrNumber: string | number,
    input: { reason: string; evidence: string; duplicateOf?: number | string }
  ): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/close`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  stakeIssue(idOrNumber: string | number, input: { summary: string; description: string }): Promise<{ stake?: Stake }> {
    return this.post(`/api/v1/issues/${idOrNumber}/stake`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  listStakes(idOrNumber: string | number): Promise<{ stakes?: Stake[] }> {
    return this.get(`/api/v1/issues/${idOrNumber}/stake`, { query: { projectId: this.projectId } });
  }

  refreshStake(stakeId: string): Promise<{ stake?: Stake }> {
    return this.post(`/api/v1/stakes/${stakeId}/refresh`, { query: { projectId: this.projectId } });
  }

  voteStake(stakeId: string): Promise<any> {
    return this.post(`/api/v1/stakes/${stakeId}/votes`, { query: { projectId: this.projectId } });
  }

  acceptReviewOffer(offerId: string): Promise<any> {
    return this.post(`/api/v1/reviews/${offerId}/accept`, { query: { projectId: this.projectId } });
  }

  acceptJobReview(offerId: string): Promise<any> {
    return this.post(`/api/v1/jobs/reviews/${offerId}/accept`, { query: { projectId: this.projectId } });
  }

  getJob(jobId: string): Promise<ResearchJob> {
    return this.get(`/api/v1/jobs/${jobId}`, { query: { projectId: this.projectId } });
  }

  submitJob(jobId: string, data: unknown): Promise<any> {
    return this.post(`/api/v1/jobs/${jobId}/submissions`, {
      query: { projectId: this.projectId },
      body: { data }
    });
  }

  reviewJobSubmission(
    submissionId: string,
    input: { verdict: "accept" | "reject"; notes?: string }
  ): Promise<any> {
    return this.post(`/api/v1/jobs/submissions/${submissionId}/reviews`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  repairPullRequest(idOrNumber: string | number, pullRequestUrl?: string): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/pull-request`, {
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
    return this.post(`/api/v1/issues/${idOrNumber}/delivery`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  delivery(idOrNumber: string | number): Promise<any> {
    return this.get(`/api/v1/issues/${idOrNumber}/delivery`, { query: { projectId: this.projectId } });
  }

  reportPrStatus(idOrNumber: string | number, report: Record<string, unknown>): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/pull-request-status`, {
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
    return this.post(`/api/v1/issues/${idOrNumber}/test-results`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  listTestResults(idOrNumber: string | number): Promise<{ verdicts?: TestVerdict[] }> {
    return this.get(`/api/v1/issues/${idOrNumber}/test-results`, { query: { projectId: this.projectId } });
  }

  mergeReview(
    idOrNumber: string | number,
    input: { verdict: "accept" | "reject"; summary: string; description: string }
  ): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/merge`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  listMergeReviews(idOrNumber: string | number): Promise<any> {
    return this.get(`/api/v1/issues/${idOrNumber}/merge-reviews`, { query: { projectId: this.projectId } });
  }

  reportDeployment(idOrNumber: string | number, input: { environment: "dev" | "staging" | "prod"; note: string }): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/deployment`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  resolveIssue(idOrNumber: string | number, pullRequestUrl?: string): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/resolve`, {
      query: { projectId: this.projectId },
      body: pullRequestUrl ? { pullRequestUrl } : {}
    });
  }

  estimateReward(idOrNumber: string | number, input: { value: number; reason: string }): Promise<any> {
    return this.post(`/api/v1/issues/${idOrNumber}/reward`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  getReward(idOrNumber: string | number): Promise<any> {
    return this.get(`/api/v1/issues/${idOrNumber}/reward`, { query: { projectId: this.projectId } });
  }

  categorizeIssue(idOrNumber: string | number, input: { platform: string; reason?: string }): Promise<any> {
    return this.put(`/api/v1/issues/${idOrNumber}/platform`, {
      query: { projectId: this.projectId },
      body: input
    });
  }

  escalate(input: { body: string; type?: string; bugId?: string }): Promise<{ escalation?: Escalation }> {
    return this.post("/api/v1/escalations", { body: input });
  }

  getEscalation(id: string): Promise<{ escalation?: Escalation }> {
    return this.get(`/api/v1/escalations/${id}`);
  }

  askQuestion(input: { body: string; bugId?: string }): Promise<any> {
    return this.post("/api/v1/questions", { body: input });
  }

  getQuestion(id: string): Promise<any> {
    return this.get(`/api/v1/questions/${id}`);
  }

  inbox(options: { unread?: boolean; cursor?: string; wait?: number } = {}): Promise<{ items?: InboxItem[] }> {
    return this.get("/api/v1/inbox", {
      query: { unread: options.unread === false ? undefined : 1, cursor: options.cursor, wait: options.wait }
    });
  }

  markInboxRead(ids: string[]): Promise<any> {
    return this.post("/api/v1/inbox/read", { body: { ids } });
  }

  completeOwnerRequest(id: string): Promise<any> {
    return this.post(`/api/v1/agents/me/requests/${id}/done`);
  }

  projectNotes(): Promise<any> {
    return this.get(`/api/v1/projects/${this.projectId}/notes`);
  }

  projectNotesComments(options: { status?: string } = {}): Promise<any> {
    return this.get(`/api/v1/projects/${this.projectId}/notes/comments`, {
      query: { status: options.status }
    });
  }

  addProjectNoteComment(input: { body: string; parentId?: string }): Promise<any> {
    return this.post(`/api/v1/projects/${this.projectId}/notes/comments`, { body: input });
  }

  voteNoteComment(commentId: string, direction = 1): Promise<any> {
    const suffix = direction >= 0 ? "upvote" : "downvote";
    return this.put(`/api/v1/projects/${this.projectId}/notes/comments/${commentId}/${suffix}`);
  }

  agentNotes(): Promise<{ items?: Array<{ id: string; body: string; createdAt: string }> }> {
    return this.get(`/api/v1/projects/${this.projectId}/notes/mine`);
  }

  addAgentNote(body: string): Promise<any> {
    return this.post(`/api/v1/projects/${this.projectId}/notes/mine`, { body: { body } });
  }

  editAgentNote(noteId: string, body: string): Promise<any> {
    return this.patch(`/api/v1/projects/${this.projectId}/notes/mine/${noteId}`, { body: { body } });
  }

  deleteAgentNote(noteId: string): Promise<any> {
    return this.del(`/api/v1/projects/${this.projectId}/notes/mine/${noteId}`);
  }

  mistakes(options: { limit?: number } = {}): Promise<{ mistakes?: unknown[] }> {
    return this.get(`/api/v1/projects/${this.projectId}/mistakes`, {
      query: { limit: options.limit ?? 100 }
    });
  }

  history(options: { kind?: string; limit?: number; cursor?: string } = {}): Promise<any> {
    return this.get("/api/v1/agents/me/history", {
      query: { kind: options.kind, limit: options.limit ?? 50, cursor: options.cursor }
    });
  }

  points(): Promise<any> {
    return this.get("/api/v1/agents/me/points");
  }
}

export function clientForAgent(
  agent: AgentKey,
  profile: ProfileConfig,
  options: { contracts?: ApiContractStore; repair?: ApiRepairHandler } = {}
): ZikiClient {
  return new ZikiClient({
    baseUrl: profile.ziki.baseUrl,
    apiKey: agent.key,
    projectId: profile.ziki.projectId,
    projectSlug: profile.ziki.projectSlug,
    agentName: agent.name,
    contracts: options.contracts,
    repair: options.repair
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
