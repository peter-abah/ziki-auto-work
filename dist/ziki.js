import { randomUUID } from "node:crypto";
import { contractKey, formatApiErrorDetails, recordRejected, repairApiBody, stripRejectedFields } from "./api-repair.js";
import { DEFAULT_ENDPOINTS, endpointVars, renderEndpoint } from "./ziki-endpoints.js";
export class ZikiError extends Error {
    status;
    body;
    method;
    path;
    cause;
    constructor(message, options = {}) {
        super(message);
        this.name = "ZikiError";
        this.status = options.status ?? 0;
        this.body = options.body ?? null;
        this.method = options.method ?? null;
        this.path = options.path ?? null;
        this.cause = options.cause ?? null;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Guard against silent shape changes: an HTML login page, a moved endpoint
 * returning prose, or a restructured payload must fail loudly here instead of
 * flowing downstream as an empty-but-valid result.
 */
function assertResponseShape(method, pathname, status, data, expect) {
    const items = data?.items;
    const ok = expect === "object"
        ? typeof data === "object" && data !== null && !Array.isArray(data)
        : Array.isArray(items) || Array.isArray(data);
    if (ok)
        return;
    const preview = typeof data === "string" ? data.slice(0, 120) : JSON.stringify(data)?.slice(0, 120);
    throw new ZikiError(`${method} ${pathname} failed: unexpected response shape (expected ${expect}, got ${preview || "empty"})`, {
        status,
        body: { error: "unexpected_response_shape", expected: expect, preview: preview ?? null },
        method,
        path: pathname
    });
}
function retryAfterMs(response, attempt, maxMs = Infinity) {
    const retry = response.headers.get("retry-after");
    if (retry) {
        const seconds = Number(retry);
        if (Number.isFinite(seconds))
            return Math.min(maxMs, Math.max(0, seconds * 1000));
        const date = Date.parse(retry);
        if (Number.isFinite(date))
            return Math.min(maxMs, Math.max(0, date - Date.now()));
    }
    const reset = response.headers.get("ratelimit-reset");
    if (reset) {
        const value = Number(reset);
        if (Number.isFinite(value)) {
            const ms = value > 1e12 ? value - Date.now() : value * 1000 - Date.now();
            if (ms > 0)
                return Math.min(maxMs, ms);
        }
    }
    return Math.min(maxMs, 60_000, 1000 * 2 ** attempt);
}
/**
 * Value to send as the `platform` query parameter on Ziki list endpoints.
 * - `ziki.platformFilter` set → send it (category renames without touching identity).
 * - `ziki.platformFilter: null` → omit the parameter.
 * - absent → send `ziki.platform` (legacy behavior).
 */
export function apiPlatformFilter(profile) {
    const override = profile.ziki.platformFilter;
    if (override === null)
        return undefined;
    if (typeof override === "string" && override.trim())
        return override.trim();
    return profile.ziki.platform;
}
export class ZikiClient {
    baseUrl;
    apiKey;
    projectId;
    projectSlug;
    orgSlug;
    vars;
    endpoints;
    agentName;
    timeoutMs;
    contracts;
    repair;
    constructor(options) {
        this.baseUrl = (options.baseUrl ?? "https://ziki.dev").replace(/\/$/, "");
        this.apiKey = options.apiKey;
        this.projectId = options.projectId;
        this.projectSlug = options.projectSlug;
        this.orgSlug = options.orgSlug ?? null;
        this.vars = { ...(options.vars ?? {}) };
        this.endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
        this.agentName = options.agentName ?? "agent";
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.contracts = options.contracts;
        this.repair = options.repair;
    }
    /**
     * Resolve a configured endpoint template into a path, interpolating
     * `{var}` placeholders from explicit params, configured vars, and identity
     * fields (projectId/projectSlug/orgSlug/platform). Throws on unknown or
     * missing required vars — a wrong but well-formed URL is worse than none.
     */
    route(group, name, params = {}) {
        const template = this.endpoints[group]?.[name] ?? DEFAULT_ENDPOINTS[group]?.[name];
        if (!template)
            throw new Error(`unknown endpoint: ${group}.${name}`);
        const vars = {
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
    url(pathname, query = {}) {
        const url = new URL(`${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null)
                continue;
            url.searchParams.set(key, String(value));
        }
        return url;
    }
    async request(method, pathname, options = {}) {
        const key = contractKey(method, pathname);
        let body = stripRejectedFields(options.body, this.contracts?.[key]?.rejected ?? []);
        let deterministicRepairs = 0;
        let agentRepairs = 0;
        for (;;) {
            try {
                return await this.requestOnce(method, pathname, { ...options, body });
            }
            catch (error) {
                if (!(error instanceof ZikiError))
                    throw error;
                if (deterministicRepairs < 2) {
                    const repaired = repairApiBody(body, error.body);
                    if (repaired?.changed) {
                        body = repaired.body;
                        if (this.contracts)
                            recordRejected(this.contracts, key, repaired.rejected);
                        deterministicRepairs += 1;
                        continue;
                    }
                }
                if (agentRepairs < 1 && this.repair && body !== undefined && [400, 422].includes(error.status)) {
                    agentRepairs += 1;
                    let repaired = null;
                    try {
                        repaired = await this.repair({
                            method,
                            path: pathname,
                            status: error.status,
                            body,
                            errorBody: error.body,
                            contractKey: key
                        });
                    }
                    catch {
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
    async requestOnce(method, pathname, options = {}) {
        const url = this.url(pathname, options.query ?? {});
        const retries = options.retries ?? 3;
        let attempt = 0;
        let lastError = null;
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
                    return { data: null, response };
                }
                if ((response.status === 429 || response.status >= 500) && attempt < retries) {
                    await sleep(retryAfterMs(response, attempt, options.maxRetryAfterMs ?? Infinity));
                    attempt += 1;
                    continue;
                }
                const text = await response.text();
                let data = null;
                if (text) {
                    try {
                        data = JSON.parse(text);
                    }
                    catch {
                        data = text;
                    }
                }
                if (!response.ok) {
                    const record = data;
                    const message = String(record?.message ?? record?.error ?? `HTTP ${response.status}`);
                    throw new ZikiError(`${method} ${pathname} failed: ${message}${formatApiErrorDetails(data)}`, {
                        status: response.status,
                        body: data,
                        method,
                        path: pathname
                    });
                }
                if (options.expect)
                    assertResponseShape(method, pathname, response.status, data, options.expect);
                if (options.raw)
                    return { data, response };
                return data;
            }
            catch (error) {
                lastError = error;
                if (error instanceof ZikiError)
                    throw error;
                if (attempt >= retries)
                    break;
                await sleep(Math.min(30_000, 1000 * 2 ** attempt));
                attempt += 1;
            }
        }
        throw new ZikiError(`${method} ${pathname} failed: ${lastError instanceof Error ? lastError.message : "network error"}`, { method, path: pathname, cause: lastError });
    }
    get(pathname, options) {
        return this.request("GET", pathname, options);
    }
    post(pathname, options) {
        return this.request("POST", pathname, options);
    }
    patch(pathname, options) {
        return this.request("PATCH", pathname, options);
    }
    put(pathname, options) {
        return this.request("PUT", pathname, options);
    }
    del(pathname, options) {
        return this.request("DELETE", pathname, options);
    }
    me() {
        return this.get(this.route("agents", "me"), { expect: "object" });
    }
    updateProfile(input) {
        return this.patch(this.route("agents", "me"), { body: input });
    }
    listSkills() {
        return this.get(this.route("agents", "skills"));
    }
    setSkills(skills) {
        return this.put(this.route("agents", "skills"), { body: { skills } });
    }
    setSkill(tag, input) {
        return this.put(this.route("agents", "skill", { tag: encodeURIComponent(tag) }), { body: input });
    }
    removeSkill(tag) {
        return this.del(this.route("agents", "skill", { tag: encodeURIComponent(tag) }));
    }
    skillTags() {
        return this.get(this.route("agents", "skillTags"), { expect: "object" });
    }
    async setPicture(file) {
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(file);
        const name = file.split(/[\\/]/).pop() || "picture";
        const form = new FormData();
        form.append("file", new Blob([bytes]), name);
        const response = await fetch(`${this.baseUrl}${this.route("agents", "picture")}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
            body: form,
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
            const picturePath = this.route("agents", "picture");
            throw new ZikiError(`PUT ${picturePath} failed: HTTP ${response.status}`, {
                status: response.status,
                body: data,
                method: "PUT",
                path: picturePath
            });
        }
        return data;
    }
    removePicture() {
        return this.del(this.route("agents", "picture"));
    }
    listAgents(tag) {
        return this.get(this.route("agents", "list"), { query: { tag } });
    }
    getAgent(username) {
        return this.get(this.route("agents", "get", { username: encodeURIComponent(username) }));
    }
    platforms() {
        return this.get(this.route("platforms", "list"), { expect: "list" });
    }
    project() {
        return this.get(this.route("projects", "get", { project: this.projectId }), { expect: "object" });
    }
    /** Read one project by id (used to verify rotation targets and parse workUrl). */
    readProject(projectId) {
        return this.get(this.route("projects", "get", { project: projectId }), { expect: "object" });
    }
    /**
     * Every project in the agent's tenant — the recovery endpoint for a retired
     * projectId. Needs no project scope, so it works while project routes 404.
     */
    listProjects() {
        return this.get(this.route("projects", "list"), { expect: "list" });
    }
    async work(options = {}) {
        const result = await this.request("GET", this.route("work", "feed"), {
            headers: options.etag ? { "If-None-Match": options.etag } : {},
            raw: true,
            expect: "feed"
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
    listIssues(options = {}) {
        return this.get(this.route("issues", "list"), {
            query: {
                projectId: this.projectId,
                platform: options.platform,
                status: options.status,
                limit: options.limit ?? 100,
                cursor: options.cursor
            },
            expect: "list"
        });
    }
    async listAllIssues(options = {}) {
        const items = [];
        let cursor;
        for (let page = 0; page < 20; page += 1) {
            const data = await this.listIssues({ ...options, limit: 100, cursor });
            items.push(...(data.items ?? []));
            cursor = data.nextCursor ?? undefined;
            if (!cursor || items.length >= (options.max ?? 600))
                break;
        }
        return items;
    }
    counts() {
        return this.get(this.route("issues", "counts"), { query: { projectId: this.projectId } });
    }
    getIssue(idOrNumber) {
        return this.get(this.route("issues", "get", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    comments(idOrNumber, options = {}) {
        return this.get(this.route("issues", "comments", { issue: idOrNumber }), {
            query: { projectId: this.projectId, limit: options.limit ?? 100, cursor: options.cursor }
        });
    }
    comment(idOrNumber, body) {
        return this.post(this.route("issues", "comments", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body
        });
    }
    upvoteComment(commentId) {
        return this.post(this.route("comments", "votes", { comment: commentId }), { query: { projectId: this.projectId } });
    }
    createIdea(input) {
        return this.post(this.route("ideas", "list"), {
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
    listIdeas(options = {}) {
        return this.get(this.route("ideas", "list"), {
            query: {
                projectId: this.projectId,
                status: options.status,
                convertible: options.convertible,
                platform: options.platform,
                limit: options.limit ?? 100,
                cursor: options.cursor
            },
            expect: "list"
        });
    }
    async listAllIdeas(options = {}) {
        const items = [];
        let cursor;
        for (let page = 0; page < 20; page += 1) {
            const data = await this.listIdeas({ ...options, limit: 100, cursor });
            items.push(...(data.items ?? []));
            cursor = data.nextCursor ?? undefined;
            if (!cursor || items.length >= (options.max ?? 600))
                break;
        }
        return items;
    }
    getIdea(idOrNumber) {
        return this.get(this.route("ideas", "get", { idea: idOrNumber }), { query: { projectId: this.projectId } });
    }
    ideaVerdicts(idOrNumber) {
        return this.get(this.route("ideas", "verdicts", { idea: idOrNumber }), { query: { projectId: this.projectId } });
    }
    giveIdeaVerdict(idOrNumber, input) {
        return this.post(this.route("ideas", "verdicts", { idea: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    convertIdea(idOrNumber) {
        return this.post(this.route("ideas", "convert", { idea: idOrNumber }), { query: { projectId: this.projectId }, body: {} });
    }
    rejectIdea(idOrNumber, body = {}) {
        return this.post(this.route("ideas", "reject", { idea: idOrNumber }), { query: { projectId: this.projectId }, body });
    }
    archiveIdea(idOrNumber, body = {}) {
        return this.post(this.route("ideas", "archive", { idea: idOrNumber }), { query: { projectId: this.projectId }, body });
    }
    categorizeIdea(idOrNumber, input) {
        return this.put(this.route("ideas", "platform", { idea: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    confirmIssue(idOrNumber, input) {
        return this.post(this.route("issues", "confirmations", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    openIssue(idOrNumber) {
        return this.post(this.route("issues", "open", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    bid(idOrNumber, input) {
        return this.post(this.route("issues", "bid", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    withdrawBid(idOrNumber) {
        return this.del(this.route("issues", "bid", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    listBids(idOrNumber) {
        return this.get(this.route("issues", "bid", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    awardBid(bidId) {
        return this.post(this.route("bids", "award", { bid: bidId }), { query: { projectId: this.projectId } });
    }
    voteBid(bidId) {
        return this.post(this.route("bids", "votes", { bid: bidId }), { query: { projectId: this.projectId } });
    }
    stake(idOrNumber, input) {
        return this.post(this.route("issues", "stake", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    acceptOffer(offerId) {
        return this.post(this.route("offers", "accept", { offer: offerId }), { query: { projectId: this.projectId } });
    }
    heartbeat(idOrNumber, options = {}) {
        return this.post(this.route("issues", "heartbeat", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            ...options
        });
    }
    extend(idOrNumber, reason) {
        return this.post(this.route("issues", "extend", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: { reason }
        });
    }
    release(idOrNumber) {
        return this.post(this.route("issues", "release", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    reclaim(idOrNumber) {
        return this.post(this.route("issues", "reclaim", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    markImportant(idOrNumber) {
        return this.post(this.route("issues", "importance", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    abandonVote(idOrNumber, summary) {
        return this.post(this.route("issues", "abandonVotes", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: { summary }
        });
    }
    suggestClose(idOrNumber, input) {
        return this.post(this.route("issues", "closeSuggestions", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    closeIssue(idOrNumber, input) {
        return this.post(this.route("issues", "close", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    stakeIssue(idOrNumber, input) {
        return this.post(this.route("issues", "stake", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    listStakes(idOrNumber) {
        return this.get(this.route("issues", "stake", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    refreshStake(stakeId) {
        return this.post(this.route("stakes", "refresh", { stake: stakeId }), { query: { projectId: this.projectId } });
    }
    voteStake(stakeId) {
        return this.post(this.route("stakes", "votes", { stake: stakeId }), { query: { projectId: this.projectId } });
    }
    acceptReviewOffer(offerId) {
        return this.post(this.route("reviews", "accept", { offer: offerId }), { query: { projectId: this.projectId } });
    }
    acceptJobReview(offerId) {
        return this.post(this.route("jobs", "acceptReview", { offer: offerId }), { query: { projectId: this.projectId } });
    }
    getJob(jobId) {
        return this.get(this.route("jobs", "get", { job: jobId }), { query: { projectId: this.projectId } });
    }
    submitJob(jobId, data) {
        return this.post(this.route("jobs", "submissions", { job: jobId }), {
            query: { projectId: this.projectId },
            body: { data }
        });
    }
    reviewJobSubmission(submissionId, input) {
        return this.post(this.route("jobs", "submitReview", { submission: submissionId }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    repairPullRequest(idOrNumber, pullRequestUrl) {
        return this.post(this.route("issues", "pullRequest", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: pullRequestUrl ? { pullRequestUrl } : {}
        });
    }
    deliver(idOrNumber, input) {
        return this.post(this.route("issues", "delivery", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    delivery(idOrNumber) {
        return this.get(this.route("issues", "delivery", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    reportPrStatus(idOrNumber, report) {
        return this.post(this.route("issues", "pullRequestStatus", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: report
        });
    }
    submitTestResult(idOrNumber, input) {
        return this.post(this.route("issues", "testResults", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    listTestResults(idOrNumber) {
        return this.get(this.route("issues", "testResults", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    mergeReview(idOrNumber, input) {
        return this.post(this.route("issues", "merge", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    listMergeReviews(idOrNumber) {
        return this.get(this.route("issues", "mergeReviews", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    reportDeployment(idOrNumber, input) {
        return this.post(this.route("issues", "deployment", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    resolveIssue(idOrNumber, pullRequestUrl) {
        return this.post(this.route("issues", "resolve", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: pullRequestUrl ? { pullRequestUrl } : {}
        });
    }
    estimateReward(idOrNumber, input) {
        return this.post(this.route("issues", "reward", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    getReward(idOrNumber) {
        return this.get(this.route("issues", "reward", { issue: idOrNumber }), { query: { projectId: this.projectId } });
    }
    categorizeIssue(idOrNumber, input) {
        return this.put(this.route("issues", "platform", { issue: idOrNumber }), {
            query: { projectId: this.projectId },
            body: input
        });
    }
    escalate(input) {
        return this.post(this.route("escalations", "create"), { body: input });
    }
    getEscalation(id) {
        return this.get(this.route("escalations", "get", { id }));
    }
    askQuestion(input) {
        return this.post(this.route("questions", "create"), { body: input });
    }
    getQuestion(id) {
        return this.get(this.route("questions", "get", { id }));
    }
    inbox(options = {}) {
        return this.get(this.route("inbox", "list"), {
            query: { unread: options.unread === false ? undefined : 1, cursor: options.cursor, wait: options.wait },
            expect: "list"
        });
    }
    markInboxRead(ids) {
        return this.post(this.route("inbox", "read"), { body: { ids } });
    }
    completeOwnerRequest(id) {
        return this.post(this.route("agents", "dismissRequest", { id }));
    }
    projectNotes() {
        return this.get(this.route("projects", "notes", { project: this.projectId }), { expect: "object" });
    }
    projectNotesComments(options = {}) {
        return this.get(this.route("projects", "notesComments", { project: this.projectId }), {
            query: { status: options.status }
        });
    }
    addProjectNoteComment(input) {
        return this.post(this.route("projects", "notesComments", { project: this.projectId }), { body: input });
    }
    voteNoteComment(commentId, direction = 1) {
        const suffix = direction >= 0 ? "upvote" : "downvote";
        return this.put(this.route("projects", "noteComment", { project: this.projectId, comment: commentId, action: suffix }));
    }
    agentNotes() {
        return this.get(this.route("projects", "myNotes", { project: this.projectId }), { expect: "list" });
    }
    addAgentNote(body) {
        return this.post(this.route("projects", "myNotes", { project: this.projectId }), { body: { body } });
    }
    editAgentNote(noteId, body) {
        return this.patch(this.route("projects", "myNote", { project: this.projectId, note: noteId }), { body: { body } });
    }
    deleteAgentNote(noteId) {
        return this.del(this.route("projects", "myNote", { project: this.projectId, note: noteId }));
    }
    mistakes(options = {}) {
        return this.get(this.route("projects", "mistakes", { project: this.projectId }), {
            query: { limit: options.limit ?? 100 }
        });
    }
    history(options = {}) {
        return this.get(this.route("agents", "history"), {
            query: { kind: options.kind, limit: options.limit ?? 50, cursor: options.cursor }
        });
    }
    points() {
        return this.get(this.route("agents", "points"));
    }
}
export function clientForAgent(agent, profile, options = {}) {
    return new ZikiClient({
        baseUrl: profile.ziki.baseUrl,
        apiKey: agent.key,
        projectId: profile.ziki.projectId,
        projectSlug: profile.ziki.projectSlug,
        orgSlug: profile.ziki.orgSlug ?? null,
        vars: profile.ziki.vars,
        endpoints: profile.ziki.endpoints,
        agentName: agent.name,
        contracts: options.contracts,
        repair: options.repair
    });
}
export function normalizeIssue(data) {
    return (data?.issue ?? data ?? null);
}
export function normalizeIdea(data) {
    return (data?.idea ?? data ?? null);
}
export function normalizeWorkItem(item) {
    return item;
}
//# sourceMappingURL=ziki.js.map