import type { AgentKey, AgentMe, AgentProfile, AgentSkillConfig, Escalation, Idea, InboxItem, Issue, ProfileConfig, ResearchJob, Stake, TestVerdict, WorkFeed, WorkItem } from "./types.js";
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
export declare class ZikiClient {
    baseUrl: string;
    apiKey: string;
    projectId: string;
    projectSlug: string;
    agentName: string;
    timeoutMs: number;
    constructor(options: {
        baseUrl?: string;
        apiKey: string;
        projectId: string;
        projectSlug: string;
        agentName?: string;
        timeoutMs?: number;
    });
    private url;
    request<T = any>(method: string, pathname: string, options?: {
        query?: Record<string, unknown>;
        body?: unknown;
        headers?: Record<string, string>;
        idempotencyKey?: string;
        raw?: boolean;
        retries?: number;
    }): Promise<T>;
    get<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    post<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    patch<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    put<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
    del<T = any>(pathname: string, options?: Parameters<ZikiClient["request"]>[2]): Promise<T>;
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
        platform?: string;
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
    heartbeat(idOrNumber: string | number): Promise<any>;
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
export declare function clientForAgent(agent: AgentKey, profile: ProfileConfig): ZikiClient;
export declare function normalizeIssue(data: any): Issue | null;
export declare function normalizeIdea(data: any): Idea | null;
export declare function normalizeWorkItem(item: WorkItem): WorkItem;
