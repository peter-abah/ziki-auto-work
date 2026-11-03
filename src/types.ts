export type ProviderName = "opencode" | "claude" | "codex" | "gemini" | "custom";
export type Role = "worker" | "review" | "triage" | "confirm" | "discovery" | "owner";
export type EscalationType =
  | "question"
  | "work_authorization"
  | "blocker"
  | "scope_change"
  | "human_approval";

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
  projectName?: string;
}

export interface RepoConfig {
  url: string;
  upstream: string;
  base: string;
  githubRepo: string;
  forkOwner: string;
  defaultBranch: string;
  teamLead?: string;
  protectedFiles?: string[];
  baselineFile?: string;
}

export interface AgentsConfig {
  workers: string[];
  managers: string[];
}

export interface ExecutorConfig {
  provider: ProviderName;
  model?: string | null;
  models?: Partial<Record<Role, string | null>>;
  extraArgs?: string[];
  env?: Record<string, string>;
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

export interface DiscoveryConfig {
  enabled: boolean;
  parityFile?: string;
  maxIdeasPerRun?: number;
  maxCyclesBeforeRun?: number;
}

export interface LimitsConfig {
  maxDeliveriesPerDay: number;
  maxReviewsPerDay: number;
  maxDiscoveriesPerDay: number;
  maxAuxPerCycle: number;
  maxActiveClaims: number;
  maxAttemptsPerTask: number;
  maxCyclesBeforeDiscovery: number;
  maxOpenEscalations: number;
  /** Default run limit in minutes; null means no time limit. */
  maxRuntimeMinutes?: number | null;
  /** Stop after this many cycles; null means no cycle limit. */
  maxCycles?: number | null;
  /** Stop at this ISO timestamp; null means no deadline. */
  stopAt?: string | null;
  /** Stop after this many deliveries in the current run; null means no limit. */
  maxDeliveriesTotal?: number | null;
  maxConcurrentDeliveries?: number;
  maxConcurrentReviews?: number;
  maxConcurrentAux?: number;
  maxConcurrentDiscovery?: number;
  maxConcurrentAgents?: number;
}

export interface RunLimitConfig {
  maxRuntimeMinutes: number | null;
  maxCycles: number | null;
  stopAt: string | null;
  maxDeliveriesTotal: number | null;
}

export type StopReason = "max-runtime" | "max-cycles" | "until" | "max-deliveries" | "stop" | "error" | null;

export interface RunState {
  startedAt: string | null;
  limits: RunLimitConfig | null;
  stopReason: StopReason;
  deliveries: number;
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

export interface HitlConfig {
  enabled: boolean;
  defaultType: EscalationType;
  notifyCommand?: string | null;
}

export interface ProfileConfig {
  ziki: ZikiConfig;
  stack?: string;
  repo: RepoConfig;
  agents: AgentsConfig;
  executor: ExecutorConfig;
  toolchain: Record<string, string>;
  checks: CheckSpec[];
  platformMatch: PlatformMatchConfig;
  prompts: PromptsConfig;
  pr: PrConfig;
  discovery: DiscoveryConfig;
  limits: LimitsConfig;
  pollSeconds: number;
  memoryRefreshMinutes: number;
  hitl: HitlConfig;
}

export interface DoctorConfig {
  minFreeGb?: number;
}

export interface Config {
  version: 3;
  activeProfile: string;
  defaults?: Partial<ProfileConfig>;
  profiles: Record<string, ProfileConfig>;
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
  keys: { workers: AgentKey[]; managers: AgentKey[] };
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
  actions: WorkAction[];
  _feedAgent?: string;
}

export interface WorkFeed {
  project: { id: string; slug: string; name: string };
  agent: { id: string; name: string; level: string };
  workUrl: string;
  pollAfterSeconds: number;
  ask: string[];
  inbox: { unread: number; path: string };
  counts: Record<string, number>;
  waiting: unknown[];
  items: WorkItem[];
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
  reward?: { reward: number; estimates: number; maxEstimates: number; fixed: boolean };
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

export type TaskStatus =
  | "queued"
  | "claimed"
  | "working"
  | "waiting_human"
  | "delivered"
  | "reviewed"
  | "done"
  | "failed"
  | "skipped";

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
  lastError?: string | null;
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
  status: "open" | "resolved" | "dismissed";
  answer: string | null;
  resolvedAt: string | null;
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
  memory: { lastContextLoad: string | null };
  feedEtags: Record<string, string>;
  baselineFailures: Record<string, string[]>;
  baselineSha: string | null;
  baselineAt: string | null;
  lastError: unknown;
  run: RunState;
  lastCycle: LastCycleSummary | null;
  activePids: number[];
}

export interface HistoryEntry {
  at: string;
  type:
    | "claim"
    | "bid"
    | "award"
    | "accept"
    | "delivery"
    | "review"
    | "merge_review"
    | "discovery"
    | "aux"
    | "escalation"
    | "failure"
    | "stop";
  issue?: number | string | null;
  idea?: number | string | null;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface AgentResult {
  ok: boolean;
  blocked?: boolean;
  summary?: string;
  description?: string;
  testResults?: string;
  testedAgainst?: string;
  howToTest?: string[];
  whatToExpect?: string;
  checks?: string[];
  files?: Array<string | { path: string; lines?: string }>;
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
  duplicateOfId?: string | number | null;
  actions?: string[];
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
  build(input: {
    prompt: string;
    cwd: string;
    resultPath: string;
    model: string | null;
  }): ProviderCommand;
  doctor(profile: ProfileConfig): Promise<{ ok: boolean; detail: string }>;
  models(profile: ProfileConfig): Promise<{ items: string[]; note?: string }>;
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
