export type ProviderName = string;
export type Role = "worker" | "review" | "followup" | "triage" | "confirm" | "discovery" | "owner" | "estimate" | "investigate" | "importance" | "stakeVote" | "senseCheck" | "close" | "research" | "jobReview" | "bidVote" | "commentVote" | "apiRepair" | "configDoctor";
export type CapacityLimit = number | "auto" | null;
export type VotePolicy = "off" | "agent" | "heuristic";
export type MergeMode = "handoff" | "never" | "auto";
export type MergeMethod = "merge" | "squash" | "rebase";
export type EscalationType = "question" | "work_authorization" | "blocker" | "scope_change" | "human_approval";
export interface PlatformMatchConfig {
    keywords?: string[];
    regex?: string;
}
export interface ZikiConfig {
    baseUrl: string;
    projectId: string;
    projectSlug: string;
    platform: string;
    platformCategoryId?: string;
    /**
     * Organisation slug for `/{org}/{project}/…` addresses. Absent on tenants
     * without organisations (legacy single-segment addresses are used then).
     * Learned from the project's `workUrl` during project re-resolution.
     */
    orgSlug?: string | null;
    /**
     * Value sent as the `platform` query parameter on Ziki list endpoints.
     * - `undefined` (absent): send `ziki.platform` (legacy behavior).
     * - a slug: send that instead (category renames without touching identity).
     * - `null`: omit the parameter entirely.
     * Agent-mutable via the config-repair flow (see RepairConfig).
     */
    platformFilter?: string | null;
    /**
     * Extra interpolation variables for endpoint templates (future Ziki
     * identifiers like `teamId`). Keys: `[A-Za-z0-9_-]+`, no dots.
     * Agent-mutable; new keys are always allowed here.
     */
    vars?: Record<string, string>;
    /**
     * Endpoint path templates, e.g. `{ issues: { list: "/api/v1/issues" } }`.
     * `{var}` interpolates from vars + identity fields; `{var?}` is optional
     * (drops out with slash-collapse). Agent-mutable: unknown Ziki URL shapes
     * are fixed in config, not code.
     */
    endpoints?: Record<string, Record<string, string>>;
    projectName?: string;
}
/**
 * Status vocabulary. Ziki renames things; these lists decide what the loop
 * does with each value instead of hardcoding it. Anything observed that is
 * not in `known` raises a visible `unknown_vocabulary` warning.
 * Agent-readable, human-written: redefining finished states can silently
 * skip paid work, so agents may not propose these paths.
 */
export interface ZikiStatusesConfig {
    /** Issues/ideas the loop may work on. */
    workable?: string[];
    /** Done states (checked against status and substatus). */
    terminal?: string[];
    /** Done-like substatuses only. */
    terminalSubstatus?: string[];
    /** Substatuses that must pass confirmation before work starts. */
    confirmation?: string[];
    /** Full known vocabulary (statuses, substatuses, feed kinds) for drift detection. */
    known?: string[];
}
/**
 * Human-tunable backoff overrides (ms), keyed by blocker code
 * (e.g. `"platform:not_found"`, `"*:unknown_kind"` also matches).
 * `null` restores the built-in default for that code.
 */
export interface HealthTuningConfig {
    retryMs?: Record<string, number | null>;
}
/**
 * Timing policy (all ms). Every interval/timeout the loop uses lives here so
 * pacing is tunable without a release. `heartbeatMs: null` (default) derives
 * the interval from Ziki's live workflow, capped at `heartbeatDefaultMs`.
 */
export interface TimingConfig {
    agentDefaultMs?: number;
    triageMs?: number;
    ownerMs?: number;
    discoveryMs?: number;
    repairMs?: number;
    doctorMs?: number;
    markRecentMs?: number;
    offlineWatchMs?: number;
    offlineFreshMs?: number;
    repoHealthMs?: number;
    heartbeatMs?: number | null;
    heartbeatDefaultMs?: number;
    reviewTransientMs?: number;
    reviewTerminalMs?: number;
    rateLimitChunkMs?: number;
}
/** One op in an agent-proposed config patch. Applied only after approval. */
export interface ConfigPatchOp {
    /** Dot path into the merged profile, e.g. `ziki.projectId`. */
    path: string;
    value: unknown;
    reason?: string;
}
/** Per-failure-code repair strategy: which agent role diagnoses it. */
export interface RepairStrategyConfig {
    /** Master switch for this failure code. Default true when the entry exists. */
    enabled?: boolean;
    /** Agent role that diagnoses and proposes the patch. Default "configDoctor". */
    role?: Role;
    /** Max proposal rounds before the escalation expires. Default 3. */
    maxRounds?: number | null;
    /** Strategy-specific matching hints, e.g. `{ matchSlug: true, matchRepo: true }`. */
    match?: Record<string, unknown>;
}
export interface RepairConfig {
    /** Master switch for agent-driven config repair. Default true. */
    enabled?: boolean;
    /** Allowlisted dot-paths an agent may propose. Defaults apply when absent. */
    mutablePaths?: string[];
    /** Paths that may be created when missing (e.g. `ziki.platformFilter`). */
    allowNewKeys?: string[];
    /** Strategies keyed by health-blocker code, e.g. `"platform:not_found"`. */
    strategies?: Record<string, RepairStrategyConfig>;
}
export interface AgentSkillConfig {
    tag: string;
    summary: string;
    description: string;
}
export interface AgentProfileConfig {
    username?: string;
    tagline?: string;
    about?: string;
    skills?: AgentSkillConfig[];
    pictureFile?: string;
}
export type PushMode = "personal-fork" | "team-fork" | "upstream";
export interface RepoConfig {
    url: string;
    upstream: string;
    base: string;
    githubRepo: string;
    forkOwner: string;
    pushMode?: PushMode;
    defaultBranch: string;
    teamLead?: string;
    protectedFiles?: string[];
    baselineFile?: string;
    envFiles?: string[];
    requiredEnv?: string[];
    mergeMode?: MergeMode;
    mergeMethod?: MergeMethod;
    requiredLabels?: string[];
    requiredReviewers?: string[];
}
export interface WorkflowConfig {
    maxFiles: number;
    maxLines: number;
    branchPrefix: string;
    commitTypes: string[];
    requireTests: boolean;
    autoVoteBids?: "off" | "agent" | "heuristic";
    autoUpvoteComments?: "off" | "agent" | "heuristic";
}
export interface AgentsConfig {
    workers: string[];
    managers: string[];
}
export interface ProviderUsageConfig {
    estimate?: boolean;
    regex?: {
        input?: string;
        output?: string;
        total?: string;
        cost?: string;
    };
}
export interface ProviderSpec {
    id: string;
    label?: string;
    command: string;
    args: string[];
    promptMode?: "arg" | "stdin";
    resultMode?: "file" | "stdout";
    autoArgs?: string[];
    safeArgs?: string[];
    modelArgs?: string[];
    models?: string[];
    doctorArgs?: string[];
    usage?: ProviderUsageConfig;
    env?: Record<string, string>;
    experimental?: boolean;
}
export interface ExecutorConfig {
    provider: ProviderName;
    model?: string | null;
    models?: Partial<Record<Role, string | null>>;
    extraArgs?: string[];
    env?: Record<string, string>;
    usage?: ProviderUsageConfig;
    timeoutMs?: number;
    permissionMode?: "auto" | "safe";
    /** Only for provider "custom". */
    command?: string;
    args?: string[];
    promptMode?: "arg" | "stdin";
}
export interface CheckSpec {
    name: string;
    command: string;
    args: string[];
    filesOnly?: boolean;
    include?: string[];
    reporter?: "json" | "text";
    baseline?: boolean;
    timeoutMs?: number;
    required?: boolean;
    env?: Record<string, string>;
}
export interface PromptsConfig {
    dir: string;
}
export interface PrConfig {
    templateFile: string;
    teamLead?: string;
}
export interface PrTrackingConfig {
    enabled: boolean;
    pollMinutes: number;
    maxFollowUps: number;
    fixFailingChecks: boolean;
    fixReviewComments: boolean;
}
export interface DiscoveryConfig {
    enabled: boolean;
    parityFile?: string;
    contextFiles?: string[];
    focus?: string;
    maxIdeasPerRun?: number;
    maxCyclesBeforeRun?: number;
    alreadyVetted?: boolean;
    vettedNote?: string;
}
export interface LimitsConfig {
    maxActiveClaims: CapacityLimit;
    maxAttemptsPerTask: number | null;
    maxNetworkRetries: number;
    networkRetryMinutes: number;
    maxCyclesBeforeDiscovery: number;
    maxOpenEscalations: number | null;
    /** Default run limit in minutes; null means no time limit. */
    maxRuntimeMinutes?: number | null;
    /** Stop after this many cycles; null means no cycle limit. */
    maxCycles?: number | null;
    /** Stop at this ISO timestamp; null means no deadline. */
    stopAt?: string | null;
    /** Stop after this many deliveries in the current run; null means no limit. */
    maxDeliveriesTotal?: number | null;
    maxConcurrentDeliveries?: CapacityLimit;
    maxConcurrentFollowUps?: CapacityLimit;
    maxConcurrentReviews?: CapacityLimit;
    maxConcurrentAux?: CapacityLimit;
    maxConcurrentDiscovery?: CapacityLimit;
    maxConcurrentAgents?: CapacityLimit;
    maxTokensPerRun?: number | null;
    tokenWarnPercent?: number;
    providerRetryMinutes?: number;
}
export interface RunLimitConfig {
    maxRuntimeMinutes: number | null;
    maxCycles: number | null;
    stopAt: string | null;
    maxDeliveriesTotal: number | null;
}
export type StopReason = "max-runtime" | "max-cycles" | "until" | "max-deliveries" | "token-limit" | "provider-limit" | "network" | "stop" | "error" | null;
export interface TokenUsage {
    input: number;
    output: number;
    total: number;
    cached?: number;
    costUsd?: number;
    estimated?: boolean;
}
export type ProviderLimit = "quota" | "rate-limit" | "context" | null;
export type HealthSeverity = "warning" | "degraded" | "blocked";
export type HealthComponent = "feed" | "inbox" | "platform" | "memory" | "provider" | "github" | "repo" | "config" | "agent" | "state";
export interface HealthBlocker {
    id: string;
    component: HealthComponent;
    code: string;
    severity: HealthSeverity;
    message: string;
    agents?: string[];
    details?: Record<string, unknown>;
    since: string;
    lastAttemptAt: string;
    attempts: number;
    nextRetryAt: string | null;
    notifiedAt: string | null;
}
export interface LoopHealth {
    state: "healthy" | "degraded" | "blocked";
    blockers: Record<string, HealthBlocker>;
    lastCheckAt: string | null;
}
export interface HealthSummary {
    state: LoopHealth["state"];
    blockers: HealthBlocker[];
}
export interface RunState {
    startedAt: string | null;
    limits: RunLimitConfig | null;
    stopReason: StopReason;
    startedCycles?: number;
    deliveries: number;
    reviews: number;
    mergeReviews: number;
    discoveries: number;
    aux: number;
    failures: number;
    networkErrors: number;
    tokens: TokenUsage;
}
export interface RunSummary {
    profile: string;
    startedAt: string;
    endedAt: string | null;
    clean: boolean;
    stopReason: StopReason | "killed";
    cycles: number;
    deliveries: number;
    reviews: number;
    mergeReviews: number;
    discoveries: number;
    aux: number;
    failures: number;
    networkErrors: number;
    interrupted: number;
    needsYou: number;
    needsYouLink: string | null;
    issues: Array<{
        number: number | string;
        title?: string | null;
        status: string;
        pr?: string | null;
    }>;
    lastActivityAt: string | null;
    tokens: TokenUsage;
    health?: HealthSummary;
}
export interface LastCycleSummary {
    at: string;
    ms: number;
    queue: Record<string, number> | null;
    deliveries: number;
    reviews: number;
    aux: number;
    errors: number;
}
export type NotifyMode = "auto" | "desktop" | "command" | "off";
export interface HitlConfig {
    enabled: boolean;
    defaultType: EscalationType;
    notify?: NotifyMode;
    notifyCommand?: string | null;
}
export interface TransportConfig {
    /** Auth scheme prefix, e.g. "Bearer". */
    authScheme?: string;
    /** User-Agent header value. */
    userAgent?: string;
    /** Default per-request timeout ms. */
    defaultTimeoutMs?: number;
    /** Default retry attempts for 429/5xx. */
    defaultRetries?: number;
    /** Cap for Retry-After / backoff waits (ms). */
    backoffCapMs?: number;
    /** Backoff growth cap for transport-level retries (ms). */
    retryGrowthCapMs?: number;
    /** Preview chars kept for unexpected-shape errors. */
    previewChars?: number;
}
export interface OperationPaginationConfig {
    limitKey?: string;
    cursorKey?: string;
    itemsKey?: string;
    nextCursorKey?: string;
    defaultLimit?: number;
    maxPages?: number;
    maxItems?: number;
}
export interface OperationConfig {
    /** Endpoint name in ziki.endpoints (defaults to the operation name). */
    route?: string;
    /** HTTP method, e.g. "GET", "POST", "PUT", "PATCH", "DELETE". */
    method?: string;
    /** Expected response shape guard: "feed" | "list" | "object". Absent = no guard. */
    expect?: "feed" | "list" | "object";
    /** Query keys sent for this operation. */
    query?: string[];
    /** Body keys sent for this operation. */
    body?: string[];
    /** Whether an idempotency key is attached. */
    idempotency?: boolean;
    /** Pagination behavior for list operations. Absent = single call. */
    pagination?: OperationPaginationConfig;
    /** Operation-specific timeout/retry overrides. */
    timeoutMs?: number;
    retries?: number;
}
export interface QueuePolicyConfig {
    priorities?: Record<string, number>;
    buckets?: {
        owner?: string[];
        work?: string[];
        review?: string[];
        aux?: string[];
    };
    noIssueKinds?: string[];
    recentMs?: number;
}
export interface ReviewGatePolicyConfig {
    transientMs?: number;
    terminalMs?: number;
    openState?: string;
    checkStates?: {
        passing?: string;
        failing?: string;
        pending?: string;
        none?: string;
    };
    workflowKeys?: string[];
}
export interface HeartbeatPolicyConfig {
    intervalMs?: number;
    eligibleStates?: string[];
    lostStatuses?: number[];
    rateLimitMs?: number;
    genericMs?: number;
    workflowKey?: string;
}
export interface DecisionsPolicyConfig {
    marker?: string;
    kinds?: string[];
    trueWords?: string[];
    falseWords?: string[];
}
export interface NoopPolicyConfig {
    statuses?: number[];
    patterns?: Record<string, string[]>;
}
export interface VotesPolicyConfig {
    defaultPolicy?: VotePolicy;
    bidMinChars?: number;
    bidKeywords?: string[];
    commentKeywords?: string[];
}
export interface IdeaPolicyConfig {
    summaryMin?: number;
    suffix?: string;
    summaryMax?: number;
    fallback?: string;
}
export interface ApiRepairPolicyConfig {
    deterministicRetries?: number;
    agentRepairs?: number;
    statuses?: number[];
}
export interface CapacityPolicyConfig {
    floor?: number;
    discoverySlots?: number;
    ownerSlots?: number;
}
export interface UrlsPolicyConfig {
    envSuffixes?: Record<string, string>;
    issuePath?: string;
    ideaPath?: string;
    inboxPath?: string;
}
export interface DiscoverPolicyConfig {
    platformSuffixes?: Record<string, string[]>;
    scores?: Record<string, number>;
    starDivisor?: number;
    starCap?: number;
    skipArchived?: boolean;
    stackMap?: Record<string, string>;
    stackPlatform?: Record<string, string>;
}
export interface GithubPolicyConfig {
    stateMap?: {
        merged?: string[];
        closed?: string[];
    };
    mergeableMap?: {
        mergeable?: string;
        conflicting?: string;
    };
    mergeFlags?: Record<string, string>;
    defaultMergeMethod?: string;
    timeouts?: {
        fetch?: number;
        view?: number;
        create?: number;
        merge?: number;
    };
}
export interface SafetyPolicyConfig {
    protectedFiles?: string[];
    secretPatterns?: string[];
}
export interface OutboxPolicyConfig {
    maxAttempts?: number;
    maxPerFlush?: number;
    fifo?: boolean;
}
export interface BootstrapPolicyConfig {
    stateFile?: string;
    needsFile?: string;
    reasonSlice?: number;
    notifySlice?: number;
    escalationSlice?: number;
    agentName?: string;
}
export interface LoopPolicyConfig {
    drainMs?: number;
    truncLen?: number;
    cacheMs?: number;
    statusAgeMs?: number;
}
export interface ChecksDefaultsConfig {
    timeoutMs?: number;
    tailLines?: number;
    requiredDefault?: boolean;
}
export interface ProfileConfig {
    ziki: ZikiConfig;
    agentProfile?: AgentProfileConfig;
    stack?: string;
    repo: RepoConfig;
    agents: AgentsConfig;
    executor: ExecutorConfig;
    toolchain: Record<string, string>;
    checks: CheckSpec[];
    checksDefaults?: ChecksDefaultsConfig;
    platformMatch: PlatformMatchConfig;
    prompts: PromptsConfig;
    pr: PrConfig;
    prTracking?: PrTrackingConfig;
    providers?: Record<string, ProviderSpec>;
    discovery: DiscoveryConfig;
    discover?: DiscoverPolicyConfig;
    workflow: WorkflowConfig;
    limits: LimitsConfig;
    pollSeconds: number;
    memoryRefreshMinutes: number;
    hitl: HitlConfig;
    repair?: RepairConfig;
    /** Status vocabulary (see ZikiStatusesConfig). Merged from defaults; human-written. */
    statuses?: ZikiStatusesConfig;
    /** Backoff overrides per blocker code (see HealthTuningConfig). */
    health?: HealthTuningConfig;
    /** Timing policy for every interval/timeout (see TimingConfig). */
    timing?: TimingConfig;
    /** Transport behavior (auth scheme, user agent, timeouts). v4: required. */
    transport?: TransportConfig;
    /** Per-operation method/query/body/pagination. v4: required. */
    operations?: Record<string, Record<string, OperationConfig>>;
    queue?: QueuePolicyConfig;
    reviewGate?: ReviewGatePolicyConfig;
    heartbeatPolicy?: HeartbeatPolicyConfig;
    decisions?: DecisionsPolicyConfig;
    noop?: NoopPolicyConfig;
    votes?: VotesPolicyConfig;
    idea?: IdeaPolicyConfig;
    apiRepair?: ApiRepairPolicyConfig;
    capacity?: CapacityPolicyConfig;
    urls?: UrlsPolicyConfig;
    github?: GithubPolicyConfig;
    safety?: SafetyPolicyConfig;
    outbox?: OutboxPolicyConfig;
    bootstrap?: BootstrapPolicyConfig;
    loop?: LoopPolicyConfig;
}
export interface DoctorConfig {
    minFreeGb?: number;
}
export interface Config {
    version: 3 | 4;
    activeProfile: string;
    defaults?: Partial<ProfileConfig>;
    profiles: Record<string, ProfileConfig>;
    providers?: Record<string, ProviderSpec>;
    doctor?: DoctorConfig;
}
export interface Paths {
    home: string;
    share: string;
    configDir: string;
    configFile: string;
    envFile: string;
    stateDir: string;
    cacheDir: string;
    bin: string;
    profilesDir: string;
    legacyShareDir: string;
    legacyStateDir: string;
    packageRoot: string;
    promptsDir: string;
    configSamplesDir: string;
    systemdDir: string;
    systemdUnit: string;
    launchdDir: string;
    launchdPlist: string;
}
export interface ProfilePaths {
    stateDir: string;
    stateFile: string;
    statusFile: string;
    logsDir: string;
    worktreesDir: string;
    reposDir: string;
    resultsDir: string;
    lockFile: string;
    pidFile: string;
    pauseFile: string;
    stopFile: string;
    needsHumanFile: string;
    ownerRequestsFile: string;
    memoryFile: string;
    desktopCacheFile: string;
    runLimitsFile: string;
    historyFile: string;
    lastRunFile: string;
    lastRunMdFile: string;
    /** Local approvals inbox (`auto-work approve`). Defaults to <stateDir>/approvals.json. */
    approvalsFile?: string;
}
export interface AgentKey {
    name: string;
    key: string;
}
export interface LoadedProfile {
    config: Config;
    profileName: string;
    profile: ProfileConfig;
    paths: Paths;
    profilePaths: ProfilePaths;
    env: Record<string, string>;
    keys: {
        workers: AgentKey[];
        managers: AgentKey[];
    };
    getKey: (name: string) => string | null;
}
export interface PlatformRef {
    id: string;
    slug: string;
    name: string;
}
export interface IssueRef {
    id: string;
    number: number;
    title: string;
    url: string;
}
export interface IdeaRef {
    id: string;
    number: number;
    title: string;
    url: string;
}
export interface WorkAction {
    name: string;
    minimumRole: string;
    method: string;
    path: string;
    cli?: string;
}
export interface WorkItem {
    kind: string;
    key: string;
    title: string;
    detail: string;
    minimumRole: string;
    canAct: boolean;
    blockedReason?: string;
    issue?: IssueRef;
    idea?: IdeaRef;
    points?: number;
    dueAt?: string;
    what?: string;
    priority?: number;
    actions: WorkAction[];
    _feedAgent?: string;
    [key: string]: unknown;
}
export interface WorkWaiting {
    kind: string;
    count: number;
    minimumRole: string;
    what?: string;
}
export interface WorkFeed {
    project: {
        id: string;
        slug: string;
        name: string;
    };
    agent: {
        id: string;
        name: string;
        level: string;
    };
    workUrl: string;
    pollAfterSeconds: number;
    ask: string[];
    inbox: {
        unread: number;
        path: string;
    };
    counts: Record<string, number>;
    waiting: WorkWaiting[];
    items: WorkItem[];
}
export interface AgentProfile {
    username?: string | null;
    tagline?: string | null;
    about?: string | null;
    rating?: number | null;
    picture_url?: string | null;
    skills?: Array<{
        tag: string;
        slug?: string;
        summary: string;
        description: string;
    }>;
}
export interface AgentMe {
    id: string;
    name: string;
    level: string;
    project_id?: string;
    project_slug?: string;
    work_url?: string | null;
    instructions?: string | null;
    profile?: AgentProfile | null;
    profile_help_url?: string;
    projects?: Array<{
        id: string;
        slug: string;
        name: string;
    }>;
    [key: string]: unknown;
}
export interface Stake {
    id: string;
    issueId?: string;
    ideaId?: string;
    agentName?: string;
    status: string;
    summary?: string;
    description?: string;
    windowEndsAt?: string;
    contestEndsAt?: string;
    refreshDueAt?: string;
    votes?: number;
    [key: string]: unknown;
}
export interface ResearchJob {
    id: string;
    brief?: string;
    pointsPerAccepted?: number;
    maxSubmissions?: number;
    submissionSchema?: unknown;
    submissions?: Array<{
        id: string;
        data?: unknown;
        status?: string;
        agentName?: string;
    }>;
    [key: string]: unknown;
}
export interface OwnerDecision {
    kind: "confirm" | "merge";
    answer: boolean;
    text: string;
    at?: string;
    author?: string;
}
export interface Holder {
    id: string;
    agentName: string;
    personName?: string;
    via?: string;
    dispatcherName?: string | null;
    status: "offered" | "active";
    offeredAt?: string;
    claimedAt?: string;
    deliverBy?: string;
}
export interface Comment {
    id: string;
    body: string;
    authorName?: string;
    by?: string;
    createdAt?: string;
    [key: string]: unknown;
}
export interface Issue {
    id: string;
    number: number;
    title: string;
    summary?: string | null;
    description?: string | null;
    status: string;
    substatus: string;
    platform?: PlatformRef | null;
    holder?: Holder | null;
    pullRequestUrl?: string | null;
    pullRequestHeadSha?: string | null;
    comments?: Comment[];
    bids?: unknown[];
    confirmations?: unknown[];
    reward?: {
        reward: number;
        estimates: number;
        maxEstimates: number;
        fixed: boolean;
    };
    [key: string]: unknown;
}
export interface Idea {
    id: string;
    number: number;
    title: string;
    summary?: string | null;
    description?: string | null;
    status: string;
    score?: number;
    platform?: PlatformRef | null;
    createdByAgentId?: string | null;
    [key: string]: unknown;
}
export interface Bid {
    id: string;
    agent_id: string;
    agent_name: string;
    beneficiary_user_id?: string;
    beneficiary_name?: string;
    votes: number;
    summary: string;
    description: string;
    [key: string]: unknown;
}
export interface Delivery {
    id: string;
    pullRequestUrl: string;
    headSha?: string;
    summary: string;
    description: string;
    screenshots?: string[];
    testResults?: string;
    [key: string]: unknown;
}
export interface ApiContractRecord {
    rejected: string[];
    updatedAt: string;
}
export type ApiContractStore = Record<string, ApiContractRecord>;
export interface TestVerdict {
    id: string;
    goodToMerge: boolean;
    summary: string;
    description: string;
    current?: boolean;
    headSha?: string;
    [key: string]: unknown;
}
export interface Escalation {
    id: string;
    body: string;
    type: EscalationType;
    status: "open" | "resolved" | "dismissed";
    resolution?: string | null;
    resolvedAt?: string | null;
    bugId?: string | null;
    bugTitle?: string | null;
    createdAt: string;
}
export interface InboxItem {
    id: string;
    kind: string;
    eventType: string;
    issueId?: string | null;
    payload?: Record<string, unknown>;
    read: boolean;
    createdAt: string;
    [key: string]: unknown;
}
export type TaskStatus = "queued" | "claimed" | "working" | "waiting_human" | "delivered" | "reviewed" | "done" | "failed" | "skipped";
export interface TaskState {
    id: string | null;
    number: number | string | null;
    title: string | null;
    status: TaskStatus;
    attempts: number;
    agentName?: string;
    claimId?: string;
    branch?: string;
    worktree?: string;
    prUrl?: string;
    headSha?: string;
    deliveredAt?: string;
    lastHeartbeatAt?: string;
    lastHeartbeatAttemptAt?: string;
    nextHeartbeatAt?: string;
    lastError?: string | null;
    prNumber?: number;
    prState?: string;
    prChecks?: "passing" | "failing" | "pending" | "none";
    prMergeable?: boolean | null;
    prReviewDecision?: string | null;
    prLastCheckedAt?: string;
    prLastHandledHeadSha?: string | null;
    prLastHandledCommentAt?: string | null;
    prLastHandledReviewDecision?: string | null;
    followUpAttempts?: number;
    lastFollowUpAt?: string | null;
    tokens?: TokenUsage;
    escalationId?: string | null;
    escalationAnswer?: string | null;
    escalationResolvedAt?: string | null;
    reason?: string;
    createdAt: string;
    updatedAt: string;
}
export interface EscalationRecord {
    id: string;
    issueId: string | null;
    issueNumber: number | null;
    issueTitle: string | null;
    type: EscalationType;
    body: string;
    agentName: string | null;
    createdAt: string;
    status: "open" | "resolved" | "dismissed" | "applied" | "expired";
    answer: string | null;
    resolvedAt: string | null;
    /**
     * Config-repair lifecycle (kind "config" only; see RepairConfig).
     * - kind "issue": legacy per-issue escalations, fields below stay null/absent.
     * - kind "config": loop-level repair proposals. `status` tracks OUR workflow
     *   state (stays "open" across clarifying rounds); `remoteStatus` mirrors Ziki.
     * - decision: how the latest human answer was interpreted.
     * - rounds: proposal rounds used (escalation + re-escalations).
     */
    kind?: "issue" | "config";
    strategy?: string | null;
    configPatch?: ConfigPatchOp[] | null;
    decision?: "approved" | "rejected" | "needs_info" | null;
    rounds?: number;
    remoteStatus?: "open" | "resolved" | "dismissed" | null;
    appliedAt?: string | null;
    previousId?: string | null;
}
export interface Counters {
    deliveries: number;
    reviews: number;
    discoveries: number;
    aux: number;
    errors: number;
}
export interface State {
    version: 1;
    profile: string | null;
    startedAt: string | null;
    stoppedAt: string | null;
    lastCycleAt: string | null;
    lastCycleMs: number | null;
    cycles: number;
    tasks: Record<string, TaskState>;
    escalations: Record<string, EscalationRecord>;
    noteDedupe: Record<string, number>;
    recentFeedKeys: Record<string, number>;
    counters: Record<string, Counters>;
    memory: {
        lastContextLoad: string | null;
    };
    feedEtags: Record<string, string>;
    apiContracts: ApiContractStore;
    lastError: unknown;
    run: RunState;
    lastCycle: LastCycleSummary | null;
    lastRun: RunSummary | null;
    activePids: number[];
    health: LoopHealth;
    /**
     * Writes that could not reach Ziki (outage/blocked project), queued FIFO
     * for the flush pass once the loop is healthy again. Tombstoned on success;
     * dropped with a history note after too many failed attempts. Never holds
     * secrets — only API payloads the loop would have sent anyway.
     */
    outbox?: OutboxQueue;
    /** Last ISO timestamps for the blocked-loop background passes. */
    lastOfflineWatchAt?: string | null;
    lastRepoHealthAt?: string | null;
}
export type OutboxKind = "createIdea" | "reportPrStatus" | "reportDeployment";
export interface OutboxEntry {
    id: string;
    kind: OutboxKind;
    /** Exact body the live call would have sent. */
    body: Record<string, unknown>;
    issueId?: string | null;
    issueNumber?: number | string | null;
    title?: string | null;
    addedAt: string;
    attempts: number;
    lastError?: string | null;
}
export interface OutboxQueue {
    items: OutboxEntry[];
    failed: OutboxEntry[];
}
export interface HistoryEntry {
    at: string;
    type: "claim" | "bid" | "award" | "accept" | "delivery" | "review" | "merge_review" | "discovery" | "aux" | "escalation" | "failure" | "decision" | "unsupported" | "health" | "outbox" | "stop";
    issue?: number | string | null;
    idea?: number | string | null;
    detail?: string;
    data?: Record<string, unknown>;
}
export interface AgentResult {
    ok: boolean;
    apiRepair?: {
        action?: "retry" | "abandon";
        input?: unknown;
        reason?: string;
    };
    blocked?: boolean;
    summary?: string;
    description?: string;
    prBody?: string;
    testResults?: string;
    testedAgainst?: string;
    howToTest?: string[];
    whatToExpect?: string;
    checks?: string[];
    files?: Array<string | {
        path: string;
        lines?: string;
    }>;
    screenshots?: string[];
    risks?: string[];
    notes?: string[];
    commitMessage?: string;
    blocker?: string | null;
    error?: string;
    exitCode?: number;
    logPath?: string;
    tail?: string;
    ideas?: Array<{
        title: string;
        summary?: string;
        description: string;
        evidence?: string;
        priority?: string;
        platform?: string;
    }>;
    opinion?: "good" | "bad" | "neutral";
    verdict?: "confirm" | "reject" | "neutral";
    goodToMerge?: boolean;
    headSha?: string;
    environmentHint?: string | null;
    vote?: boolean;
    duplicateOfId?: string | number | null;
    actions?: string[];
    value?: number;
    reason?: string;
    important?: boolean;
    abandon?: boolean;
    stakeId?: string;
    voteForStakeId?: string;
    convert?: boolean;
    reject?: boolean;
    comment?: string;
    jobId?: string;
    submissionId?: string;
    jobData?: unknown;
    closeReason?: string;
    duplicateOf?: number | string;
    evidence?: string;
    tokens?: TokenUsage;
    providerLimit?: ProviderLimit;
    /**
     * Config-repair proposal (configDoctor role only). The orchestrator validates
     * each op against RepairConfig.mutablePaths, applies NOTHING itself, and only
     * persists the patch after human approval via escalation.
     */
    configPatch?: ConfigPatchOp[];
}
/** One project in the agent's tenant, from GET /api/v1/projects. */
export interface ProjectSummary {
    id: string;
    slug: string;
    name: string;
    repoUrl?: string | null;
    stagingUrl?: string | null;
    openIssueCount?: number;
    [key: string]: unknown;
}
export interface CheckResult {
    name: string;
    ok: boolean;
    required: boolean;
    output: string;
    failures?: string[];
    newFailures?: string[];
}
export interface CheckRunResult {
    ok: boolean;
    results: CheckResult[];
}
export interface ProviderCommand {
    command: string;
    args: string[];
    env?: Record<string, string>;
    stdin?: string;
}
export interface ProviderAdapter {
    name: ProviderName;
    resultMode?: "file" | "stdout";
    parseUsage?: (text: string) => TokenUsage | null;
    build(input: {
        prompt: string;
        cwd: string;
        resultPath: string;
        model: string | null;
    }): ProviderCommand;
    doctor(profile: ProfileConfig): Promise<{
        ok: boolean;
        detail: string;
    }>;
    models(profile: ProfileConfig): Promise<{
        items: string[];
        note?: string;
    }>;
}
export interface QueueEntry {
    key: string;
    kind: string;
    priority: number;
    item: WorkItem;
    issueId: string | null;
    issueNumber: number | null;
    ideaId: string | null;
    ideaNumber: number | null;
    title: string;
    detail: string;
    actions: WorkAction[];
    bucket: "owner" | "work" | "review" | "aux" | "other";
}
export interface Queue {
    all: QueueEntry[];
    owner: QueueEntry[];
    work: QueueEntry[];
    review: QueueEntry[];
    aux: QueueEntry[];
    other: QueueEntry[];
    counts: Record<string, number>;
}
