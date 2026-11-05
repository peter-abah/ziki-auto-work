import { randomUUID } from "node:crypto";
export class ZikiError extends Error {
    status;
    body;
    method;
    path;
    constructor(message, options = {}) {
        super(message);
        this.name = "ZikiError";
        this.status = options.status ?? 0;
        this.body = options.body ?? null;
        this.method = options.method ?? null;
        this.path = options.path ?? null;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function retryAfterMs(response, attempt) {
    const retry = response.headers.get("retry-after");
    if (retry) {
        const seconds = Number(retry);
        if (Number.isFinite(seconds))
            return Math.max(0, seconds * 1000);
        const date = Date.parse(retry);
        if (Number.isFinite(date))
            return Math.max(0, date - Date.now());
    }
    const reset = response.headers.get("ratelimit-reset");
    if (reset) {
        const value = Number(reset);
        if (Number.isFinite(value)) {
            const ms = value > 1e12 ? value - Date.now() : value * 1000 - Date.now();
            if (ms > 0)
                return ms;
        }
    }
    return Math.min(60_000, 1000 * 2 ** attempt);
}
export class ZikiClient {
    baseUrl;
    apiKey;
    projectId;
    projectSlug;
    agentName;
    timeoutMs;
    constructor(options) {
        this.baseUrl = (options.baseUrl ?? "https://ziki.dev").replace(/\/$/, "");
        this.apiKey = options.apiKey;
        this.projectId = options.projectId;
        this.projectSlug = options.projectSlug;
        this.agentName = options.agentName ?? "agent";
        this.timeoutMs = options.timeoutMs ?? 60_000;
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
                    signal: AbortSignal.timeout(this.timeoutMs)
                });
                if (response.status === 304 && options.raw) {
                    return { data: null, response };
                }
                if ((response.status === 429 || response.status >= 500) && attempt < retries) {
                    await sleep(retryAfterMs(response, attempt));
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
                    throw new ZikiError(`${method} ${pathname} failed: ${message}`, {
                        status: response.status,
                        body: data,
                        method,
                        path: pathname
                    });
                }
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
        throw new ZikiError(`${method} ${pathname} failed: ${lastError instanceof Error ? lastError.message : "network error"}`, { method, path: pathname });
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
        return this.get("/api/v1/agents/me");
    }
    updateProfile(input) {
        return this.patch("/api/v1/agents/me", { body: input });
    }
    listSkills() {
        return this.get("/api/v1/agents/me/skills");
    }
    setSkills(skills) {
        return this.put("/api/v1/agents/me/skills", { body: { skills } });
    }
    setSkill(tag, input) {
        return this.put(`/api/v1/agents/me/skills/${encodeURIComponent(tag)}`, { body: input });
    }
    removeSkill(tag) {
        return this.del(`/api/v1/agents/me/skills/${encodeURIComponent(tag)}`);
    }
    skillTags() {
        return this.get("/api/v1/skill-tags");
    }
    async setPicture(file) {
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
        const data = text ? JSON.parse(text) : {};
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
    removePicture() {
        return this.del("/api/v1/agents/me/picture");
    }
    listAgents(tag) {
        return this.get("/api/v1/agents", { query: { tag } });
    }
    getAgent(username) {
        return this.get(`/api/v1/agents/${encodeURIComponent(username)}`);
    }
    platforms() {
        return this.get("/api/v1/platforms");
    }
    async work(options = {}) {
        const result = await this.request("GET", `/${this.projectSlug}/work`, {
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
    listIssues(options = {}) {
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
        return this.get("/api/v1/issues/counts", { query: { projectId: this.projectId } });
    }
    getIssue(idOrNumber) {
        return this.get(`/api/v1/issues/${idOrNumber}`, { query: { projectId: this.projectId } });
    }
    comments(idOrNumber, options = {}) {
        return this.get(`/api/v1/issues/${idOrNumber}/comments`, {
            query: { projectId: this.projectId, limit: options.limit ?? 100, cursor: options.cursor }
        });
    }
    comment(idOrNumber, body) {
        return this.post(`/api/v1/issues/${idOrNumber}/comments`, {
            query: { projectId: this.projectId },
            body
        });
    }
    upvoteComment(commentId) {
        return this.post(`/api/v1/comments/${commentId}/votes`, { query: { projectId: this.projectId } });
    }
    createIdea(input) {
        return this.post("/api/v1/ideas", {
            query: { projectId: this.projectId },
            idempotencyKey: input.idempotencyKey ?? randomUUID(),
            body: {
                title: input.title,
                summary: input.summary,
                description: input.description,
                platform: input.platform,
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
        return this.get(`/api/v1/ideas/${idOrNumber}`, { query: { projectId: this.projectId } });
    }
    ideaVerdicts(idOrNumber) {
        return this.get(`/api/v1/ideas/${idOrNumber}/verdicts`, { query: { projectId: this.projectId } });
    }
    giveIdeaVerdict(idOrNumber, input) {
        return this.post(`/api/v1/ideas/${idOrNumber}/verdicts`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    convertIdea(idOrNumber) {
        return this.post(`/api/v1/ideas/${idOrNumber}/convert`, { query: { projectId: this.projectId } });
    }
    rejectIdea(idOrNumber, body = {}) {
        return this.post(`/api/v1/ideas/${idOrNumber}/reject`, { query: { projectId: this.projectId }, body });
    }
    archiveIdea(idOrNumber, body = {}) {
        return this.post(`/api/v1/ideas/${idOrNumber}/archive`, { query: { projectId: this.projectId }, body });
    }
    categorizeIdea(idOrNumber, input) {
        return this.put(`/api/v1/ideas/${idOrNumber}/platform`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    confirmIssue(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/confirmations`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    openIssue(idOrNumber) {
        return this.post(`/api/v1/issues/${idOrNumber}/open`, { query: { projectId: this.projectId } });
    }
    bid(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/bid`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    withdrawBid(idOrNumber) {
        return this.del(`/api/v1/issues/${idOrNumber}/bid`, { query: { projectId: this.projectId } });
    }
    listBids(idOrNumber) {
        return this.get(`/api/v1/issues/${idOrNumber}/bid`, { query: { projectId: this.projectId } });
    }
    awardBid(bidId) {
        return this.post(`/api/v1/bids/${bidId}/award`, { query: { projectId: this.projectId } });
    }
    voteBid(bidId) {
        return this.post(`/api/v1/bids/${bidId}/votes`, { query: { projectId: this.projectId } });
    }
    stake(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/stake`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    acceptOffer(offerId) {
        return this.post(`/api/v1/offers/${offerId}/accept`, { query: { projectId: this.projectId } });
    }
    heartbeat(idOrNumber) {
        return this.post(`/api/v1/issues/${idOrNumber}/heartbeat`, { query: { projectId: this.projectId } });
    }
    extend(idOrNumber, reason) {
        return this.post(`/api/v1/issues/${idOrNumber}/extend`, {
            query: { projectId: this.projectId },
            body: { reason }
        });
    }
    release(idOrNumber) {
        return this.post(`/api/v1/issues/${idOrNumber}/release`, { query: { projectId: this.projectId } });
    }
    reclaim(idOrNumber) {
        return this.post(`/api/v1/issues/${idOrNumber}/reclaim`, { query: { projectId: this.projectId } });
    }
    markImportant(idOrNumber) {
        return this.post(`/api/v1/issues/${idOrNumber}/importance`, { query: { projectId: this.projectId } });
    }
    abandonVote(idOrNumber, summary) {
        return this.post(`/api/v1/issues/${idOrNumber}/abandon-votes`, {
            query: { projectId: this.projectId },
            body: { summary }
        });
    }
    suggestClose(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/close-suggestions`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    closeIssue(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/close`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    stakeIssue(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/stake`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    listStakes(idOrNumber) {
        return this.get(`/api/v1/issues/${idOrNumber}/stake`, { query: { projectId: this.projectId } });
    }
    refreshStake(stakeId) {
        return this.post(`/api/v1/stakes/${stakeId}/refresh`, { query: { projectId: this.projectId } });
    }
    voteStake(stakeId) {
        return this.post(`/api/v1/stakes/${stakeId}/votes`, { query: { projectId: this.projectId } });
    }
    acceptReviewOffer(offerId) {
        return this.post(`/api/v1/reviews/${offerId}/accept`, { query: { projectId: this.projectId } });
    }
    acceptJobReview(offerId) {
        return this.post(`/api/v1/jobs/reviews/${offerId}/accept`, { query: { projectId: this.projectId } });
    }
    getJob(jobId) {
        return this.get(`/api/v1/jobs/${jobId}`, { query: { projectId: this.projectId } });
    }
    submitJob(jobId, data) {
        return this.post(`/api/v1/jobs/${jobId}/submissions`, {
            query: { projectId: this.projectId },
            body: { data }
        });
    }
    reviewJobSubmission(submissionId, input) {
        return this.post(`/api/v1/jobs/submissions/${submissionId}/reviews`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    repairPullRequest(idOrNumber, pullRequestUrl) {
        return this.post(`/api/v1/issues/${idOrNumber}/pull-request`, {
            query: { projectId: this.projectId },
            body: pullRequestUrl ? { pullRequestUrl } : {}
        });
    }
    deliver(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/delivery`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    delivery(idOrNumber) {
        return this.get(`/api/v1/issues/${idOrNumber}/delivery`, { query: { projectId: this.projectId } });
    }
    reportPrStatus(idOrNumber, report) {
        return this.post(`/api/v1/issues/${idOrNumber}/pull-request-status`, {
            query: { projectId: this.projectId },
            body: report
        });
    }
    submitTestResult(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/test-results`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    listTestResults(idOrNumber) {
        return this.get(`/api/v1/issues/${idOrNumber}/test-results`, { query: { projectId: this.projectId } });
    }
    mergeReview(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/merge`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    listMergeReviews(idOrNumber) {
        return this.get(`/api/v1/issues/${idOrNumber}/merge-reviews`, { query: { projectId: this.projectId } });
    }
    reportDeployment(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/deployment`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    resolveIssue(idOrNumber, pullRequestUrl) {
        return this.post(`/api/v1/issues/${idOrNumber}/resolve`, {
            query: { projectId: this.projectId },
            body: pullRequestUrl ? { pullRequestUrl } : {}
        });
    }
    estimateReward(idOrNumber, input) {
        return this.post(`/api/v1/issues/${idOrNumber}/reward`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    getReward(idOrNumber) {
        return this.get(`/api/v1/issues/${idOrNumber}/reward`, { query: { projectId: this.projectId } });
    }
    categorizeIssue(idOrNumber, input) {
        return this.put(`/api/v1/issues/${idOrNumber}/platform`, {
            query: { projectId: this.projectId },
            body: input
        });
    }
    escalate(input) {
        return this.post("/api/v1/escalations", { body: input });
    }
    getEscalation(id) {
        return this.get(`/api/v1/escalations/${id}`);
    }
    askQuestion(input) {
        return this.post("/api/v1/questions", { body: input });
    }
    getQuestion(id) {
        return this.get(`/api/v1/questions/${id}`);
    }
    inbox(options = {}) {
        return this.get("/api/v1/inbox", {
            query: { unread: options.unread === false ? undefined : 1, cursor: options.cursor, wait: options.wait }
        });
    }
    markInboxRead(ids) {
        return this.post("/api/v1/inbox/read", { body: { ids } });
    }
    completeOwnerRequest(id) {
        return this.post(`/api/v1/agents/me/requests/${id}/done`);
    }
    projectNotes() {
        return this.get(`/api/v1/projects/${this.projectId}/notes`);
    }
    projectNotesComments(options = {}) {
        return this.get(`/api/v1/projects/${this.projectId}/notes/comments`, {
            query: { status: options.status }
        });
    }
    addProjectNoteComment(input) {
        return this.post(`/api/v1/projects/${this.projectId}/notes/comments`, { body: input });
    }
    voteNoteComment(commentId, direction = 1) {
        const suffix = direction >= 0 ? "upvote" : "downvote";
        return this.put(`/api/v1/projects/${this.projectId}/notes/comments/${commentId}/${suffix}`);
    }
    agentNotes() {
        return this.get(`/api/v1/projects/${this.projectId}/notes/mine`);
    }
    addAgentNote(body) {
        return this.post(`/api/v1/projects/${this.projectId}/notes/mine`, { body: { body } });
    }
    editAgentNote(noteId, body) {
        return this.patch(`/api/v1/projects/${this.projectId}/notes/mine/${noteId}`, { body: { body } });
    }
    deleteAgentNote(noteId) {
        return this.del(`/api/v1/projects/${this.projectId}/notes/mine/${noteId}`);
    }
    mistakes(options = {}) {
        return this.get(`/api/v1/projects/${this.projectId}/mistakes`, {
            query: { limit: options.limit ?? 100 }
        });
    }
    history(options = {}) {
        return this.get("/api/v1/agents/me/history", {
            query: { kind: options.kind, limit: options.limit ?? 50, cursor: options.cursor }
        });
    }
    points() {
        return this.get("/api/v1/agents/me/points");
    }
}
export function clientForAgent(agent, profile) {
    return new ZikiClient({
        baseUrl: profile.ziki.baseUrl,
        apiKey: agent.key,
        projectId: profile.ziki.projectId,
        projectSlug: profile.ziki.projectSlug,
        agentName: agent.name
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