import type { Config, ConfigPatchOp, HealthBlocker, Idea, Issue, ProfileConfig, ProfilePaths, LoadedProfile, Queue, RunLimitConfig, State, WorkFeed } from "./types.js";
import type { Logger } from "./log.js";
import { Mutex } from "./mutex.js";
import { TaskPool } from "./scheduler.js";
import type { ZikiClient } from "./ziki.js";
import { GitHub } from "./github.js";
import type { MemoryContext } from "./memory.js";
import type { Capacity } from "./capacity.js";
interface AgentClient {
    name: string;
    key: string;
    client: ZikiClient;
}
interface Context {
    loaded: LoadedProfile;
    config: Config;
    profile: ProfileConfig;
    profileName: string;
    profilePaths: ProfilePaths;
    state: State;
    logger: Logger;
    clients: {
        workers: AgentClient[];
        managers: AgentClient[];
    };
    primary: AgentClient;
    github: GitHub;
    repoReady: boolean;
    memory: MemoryContext | null;
    memoryText: string;
    feedCache: Record<string, WorkFeed>;
    feed: WorkFeed | null;
    queue: Queue | null;
    platform: {
        issues: Issue[];
        ideas: Idea[];
        fetchedAt: string | null;
    };
    dryRun: boolean;
    pool: TaskPool;
    mutex: Mutex;
    runLimits: RunLimitConfig;
    auxLastKind: string | null;
    reservedAgents: Set<string>;
    cycleStats: {
        deliveries: number;
        reviews: number;
        aux: number;
        errors: number;
    };
    lastNeedsYouCount: number | null;
    tokenWarned: boolean;
    tokenLimitReached: boolean;
    providerLimit: "quota" | null;
    providerLimitNotified: boolean;
    rateLimitUntil: number;
    rateLimitCount: number;
    phase: string;
    activity: string | null;
    phaseStartedAt: string | null;
    live: {
        note: (message: string) => void;
    } | null;
    consecutiveNetworkErrors: number;
    capacity: Capacity;
    unsupportedKinds: Set<string>;
    profileSynced: boolean;
    feedAgentCounts: Record<string, number>;
    /** mtime of config.json when ctx.profile was loaded; hot-reload on change. */
    configMtimeMs: number | null;
    zikiWorkflow: Record<string, unknown> | null;
    reservedTargets: Set<string>;
    statusTimer: NodeJS.Timeout | null;
}
/**
 * Deterministic diagnosis for a repair code: live reads only, no agent.
 * Returns ops to propose plus a done flag when the diagnosis itself resolves
 * the cycle (repair applied inline) or finds nothing actionable.
 */
export declare function diagnoseForCode(ctx: Context, code: string, blocker: HealthBlocker): Promise<{
    evidence: string[];
    ops: ConfigPatchOp[];
    summary: string;
    done: "wait" | "continue" | null;
}>;
/**
 * Live verification for proposed endpoint ops: render the candidate template
 * with identity vars and GET it through the primary client. Only a proven
 * miss (404 + "no such API route") drops the op; anything else is kept —
 * absence of proof is not proof of absence, and the human decides via APPROVE.
 * Parameterized templates ({issue}, …) cannot render without an id and are
 * kept as unverifiable. Read-only; never writes.
 */
export declare function verifyEndpointOps(ctx: Context, ops: ConfigPatchOp[]): Promise<{
    ops: ConfigPatchOp[];
    notes: string[];
}>;
export declare function normalizeCommitMessage(message: string | undefined, issue: Issue, commitTypes: string[]): string;
export declare function runLoop(options?: {
    profileName?: string;
    foreground?: boolean;
    verbose?: boolean;
    once?: boolean;
    dryRun?: boolean;
    limits?: Partial<RunLimitConfig> | null;
}): Promise<number>;
export declare function runOnceDry(profileName?: string): Promise<number>;
export {};
