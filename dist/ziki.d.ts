import type { AgentKey, AgentMe, AgentProfile, AgentSkillConfig, Escalation, Idea, InboxItem, Issue, OperationConfig, ProfileConfig, ResearchJob, Stake, TestVerdict, TransportConfig, WorkFeed, WorkItem, ApiContractStore, ProjectSummary } from "./types.js";
export declare class ZikiError extends Error {
    status: number;
    body: unknown;
    method: string | null;
    path: string | null;
    cause: unknown;
    constructor(message: string, options?: {
        status?: number;
        body?: unknown;
        method?: string | null;
        path?: string | null;
        cause?: unknown;
    });
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
export declare function apiPlatformFilter(profile: ProfileConfig): string | undefined;
export declare class ZikiClient {
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
    apiRepairPolicy?: {
        deterministicRetries?: number;
        agentRepairs?: number;
        statuses?: number[];
    };
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
        apiRepairPolicy?: {
            deterministicRetries?: number;
            agentRepairs?: number;
            statuses?: number[];
        };
    });
    /** Operation contract for group.name — throws unknown_operation when absent. */
    op(group: string, name: string): OperationConfig;
    /**
     * Resolve a configured endpoint template into a path, interpolating
     * `{var}` placeholders from explicit params, configured vars, and identity
     * fields (projectId/projectSlug/orgSlug/platform). Throws on unknown or
     * missing required vars — a wrong but well-formed URL is worse than none.
     * No built-in fallback: unknown names fail loud so URL-shape changes
     * surface as repair proposals instead of silent wrong calls.
     */
    route(group: string, name: string, params?: Record<string, string | number>): string;
    private url;
    /** Policy knobs for the adaptive repair loop (apiRepair config section). */
    repairPolicy(): {
        deterministicRetries: number;
        agentRepairs: number;
        statuses: number[];
    };
    request<T = any>(method: string, pathname: string, options?: {
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
    }): Promise<T>;
    private requestOnce;
    get<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    post<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    patch<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    put<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    del<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    /**
     * Config-driven operation call. Method, expected shape, timeout and retry
     * budget come from `operations.<group>.<name>` — a Ziki method change,
     * renamed payload or new pagination policy is a config patch, never code.
     * Thin typed wrappers below supply only field data (the loop's own inputs).
     */
    invoke<T = any>(group: string, name: string, options?: {
        params?: Record<string, string | number>;
        query?: Record<string, unknown>;
        body?: unknown;
        headers?: Record<string, string>;
        raw?: boolean;
        timeoutMs?: number;
        retries?: number;
        maxRetryAfterMs?: number;
        idempotencyKey?: string;
    }): Promise<T>;
    /**
     * Config-driven cursor pagination. Keys, page size and page/item caps come
     * from `operations.<group>.<name>.pagination`.
     */
    listAllOp<T = any>(group: string, name: string, options?: {
        params?: Record<string, string | number>;
        query?: Record<string, unknown>;
        max?: number;
    }): Promise<T[]>;
    me(): Promise<AgentMe>;
    updateProfile(input: {
        username?: string;
        tagline?: string | null;
        about?: string | null;
    }): Promise<AgentProfile>;
    listSkills(): Promise<{
        skills?: AgentSkillConfig[];
    }>;
    setSkills(skills: AgentSkillConfig[]): Promise<{
        skills?: AgentSkillConfig[];
    }>;
    setSkill(tag: string, input: {
        summary: string;
        description: string;
    }): Promise<{
        skills?: AgentSkillConfig[];
    }>;
    removeSkill(tag: string): Promise<any>;
    skillTags(): Promise<{
        tags?: Array<{
            name: string;
            slug: string;
            agents: number;
        }>;
    }>;
    setPicture(file: string): Promise<{
        picture_url?: string;
    }>;
    removePicture(): Promise<any>;
    listAgents(tag?: string): Promise<{
        agents?: AgentProfile[];
    }>;
    getAgent(username: string): Promise<AgentProfile>;
    platforms(): Promise<any>;
    project(): Promise<any>;
    /** Read one project by id (used to verify rotation targets and parse workUrl). */
    readProject(projectId: string): Promise<ProjectSummary & {
        workUrl?: string;
    }>;
    /**
     * Every project in the agent's tenant — the recovery endpoint for a retired
     * projectId. Needs no project scope, so it works while project routes 404.
     */
    listProjects(): Promise<{
        items: ProjectSummary[];
    }>;
    work(options?: {
        etag?: string;
    }): Promise<{
        notModified: boolean;
        data?: WorkFeed;
        etag?: string;
    }>;
    listIssues(options?: {
        platform?: string;
        status?: string;
        limit?: number;
        cursor?: string;
    }): Promise<any>;
    listAllIssues(options?: {
        platform?: string;
        status?: string;
        max?: number;
    }): Promise<Issue[]>;
    counts(): Promise<any>;
    getIssue(idOrNumber: string | number): Promise<any>;
    comments(idOrNumber: string | number, options?: {
        limit?: number;
        cursor?: string;
    }): Promise<any>;
    comment(idOrNumber: string | number, body: Record<string, unknown>): Promise<any>;
    upvoteComment(commentId: string): Promise<any>;
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
    }): Promise<any>;
    listIdeas(options?: {
        status?: string;
        convertible?: boolean;
        platform?: string;
        limit?: number;
        cursor?: string;
    }): Promise<any>;
    listAllIdeas(options?: {
        platform?: string;
        status?: string;
        max?: number;
    }): Promise<Idea[]>;
    getIdea(idOrNumber: string | number): Promise<any>;
    ideaVerdicts(idOrNumber: string | number): Promise<any>;
    giveIdeaVerdict(idOrNumber: string | number, input: {
        opinion: "good" | "bad" | "neutral";
        votes?: number;
        summary: string;
        description: string;
    }): Promise<any>;
    convertIdea(idOrNumber: string | number): Promise<any>;
    rejectIdea(idOrNumber: string | number, body?: Record<string, unknown>): Promise<any>;
    archiveIdea(idOrNumber: string | number, body?: Record<string, unknown>): Promise<any>;
    categorizeIdea(idOrNumber: string | number, input: {
        platform: string;
        reason?: string;
    }): Promise<any>;
    confirmIssue(idOrNumber: string | number, input: {
        verdict: "confirm" | "reject" | "neutral";
        summary: string;
        description: string;
        files?: Array<{
            path: string;
            lines?: string;
        }>;
        duplicateOfId?: string | number;
        attachmentIds?: string[];
    }): Promise<any>;
    openIssue(idOrNumber: string | number): Promise<any>;
    bid(idOrNumber: string | number, input: {
        summary: string;
        description: string;
    }): Promise<any>;
    withdrawBid(idOrNumber: string | number): Promise<any>;
    listBids(idOrNumber: string | number): Promise<any>;
    awardBid(bidId: string): Promise<any>;
    voteBid(bidId: string): Promise<any>;
    stake(idOrNumber: string | number, input: {
        summary: string;
        description: string;
    }): Promise<any>;
    acceptOffer(offerId: string): Promise<any>;
    heartbeat(idOrNumber: string | number, options?: {
        timeoutMs?: number;
        retries?: number;
        maxRetryAfterMs?: number;
    }): Promise<any>;
    extend(idOrNumber: string | number, reason: string): Promise<any>;
    release(idOrNumber: string | number): Promise<any>;
    reclaim(idOrNumber: string | number): Promise<any>;
    markImportant(idOrNumber: string | number): Promise<any>;
    abandonVote(idOrNumber: string | number, summary: string): Promise<any>;
    suggestClose(idOrNumber: string | number, input: {
        reason: string;
        evidence: string;
        summary: string;
        description?: string;
        duplicateOf?: number | string;
    }): Promise<any>;
    closeIssue(idOrNumber: string | number, input: {
        reason: string;
        evidence: string;
        duplicateOf?: number | string;
    }): Promise<any>;
    stakeIssue(idOrNumber: string | number, input: {
        summary: string;
        description: string;
    }): Promise<{
        stake?: Stake;
    }>;
    listStakes(idOrNumber: string | number): Promise<{
        stakes?: Stake[];
    }>;
    refreshStake(stakeId: string): Promise<{
        stake?: Stake;
    }>;
    voteStake(stakeId: string): Promise<any>;
    acceptReviewOffer(offerId: string): Promise<any>;
    acceptJobReview(offerId: string): Promise<any>;
    getJob(jobId: string): Promise<ResearchJob>;
    submitJob(jobId: string, data: unknown): Promise<any>;
    reviewJobSubmission(submissionId: string, input: {
        verdict: "accept" | "reject";
        notes?: string;
    }): Promise<any>;
    repairPullRequest(idOrNumber: string | number, pullRequestUrl?: string): Promise<any>;
    deliver(idOrNumber: string | number, input: {
        pullRequestUrl: string;
        summary: string;
        description: string;
        screenshots?: string[];
        testResults?: string;
        headSha?: string;
    }): Promise<any>;
    delivery(idOrNumber: string | number): Promise<any>;
    reportPrStatus(idOrNumber: string | number, report: Record<string, unknown>): Promise<any>;
    submitTestResult(idOrNumber: string | number, input: {
        goodToMerge: boolean;
        summary: string;
        description: string;
        files?: Array<{
            path: string;
            lines?: string;
        }>;
        headSha?: string;
    }): Promise<any>;
    listTestResults(idOrNumber: string | number): Promise<{
        verdicts?: TestVerdict[];
    }>;
    mergeReview(idOrNumber: string | number, input: {
        verdict: "accept" | "reject";
        summary: string;
        description: string;
    }): Promise<any>;
    listMergeReviews(idOrNumber: string | number): Promise<any>;
    reportDeployment(idOrNumber: string | number, input: {
        environment: "dev" | "staging" | "prod";
        note: string;
    }): Promise<any>;
    resolveIssue(idOrNumber: string | number, pullRequestUrl?: string): Promise<any>;
    estimateReward(idOrNumber: string | number, input: {
        value: number;
        reason: string;
    }): Promise<any>;
    getReward(idOrNumber: string | number): Promise<any>;
    categorizeIssue(idOrNumber: string | number, input: {
        platform: string;
        reason?: string;
    }): Promise<any>;
    escalate(input: {
        body: string;
        type?: string;
        bugId?: string;
    }): Promise<{
        escalation?: Escalation;
    }>;
    getEscalation(id: string): Promise<{
        escalation?: Escalation;
    }>;
    askQuestion(input: {
        body: string;
        bugId?: string;
    }): Promise<any>;
    getQuestion(id: string): Promise<any>;
    inbox(options?: {
        unread?: boolean;
        cursor?: string;
        wait?: number;
    }): Promise<{
        items?: InboxItem[];
    }>;
    markInboxRead(ids: string[]): Promise<any>;
    completeOwnerRequest(id: string): Promise<any>;
    projectNotes(): Promise<any>;
    projectNotesComments(options?: {
        status?: string;
    }): Promise<any>;
    addProjectNoteComment(input: {
        body: string;
        parentId?: string;
    }): Promise<any>;
    voteNoteComment(commentId: string, direction?: number): Promise<any>;
    agentNotes(): Promise<{
        items?: Array<{
            id: string;
            body: string;
            createdAt: string;
        }>;
    }>;
    addAgentNote(body: string): Promise<any>;
    editAgentNote(noteId: string, body: string): Promise<any>;
    deleteAgentNote(noteId: string): Promise<any>;
    mistakes(options?: {
        limit?: number;
    }): Promise<{
        mistakes?: unknown[];
    }>;
    history(options?: {
        kind?: string;
        limit?: number;
        cursor?: string;
    }): Promise<any>;
    points(): Promise<any>;
}
export declare function clientForAgent(agent: AgentKey, profile: ProfileConfig, options?: {
    contracts?: ApiContractStore;
    repair?: ApiRepairHandler;
    apiRepairPolicy?: {
        deterministicRetries?: number;
        agentRepairs?: number;
        statuses?: number[];
    };
}): ZikiClient;
export declare function normalizeIssue(data: any): Issue | null;
export declare function normalizeIdea(data: any): Idea | null;
export declare function normalizeWorkItem(item: WorkItem): WorkItem;
