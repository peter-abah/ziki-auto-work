export type TaskKind = "delivery" | "followup" | "review" | "aux" | "discovery" | "owner";
export interface TaskPoolLimits {
    delivery: number;
    followup: number;
    review: number;
    aux: number;
    discovery: number;
    owner: number;
    agents: number;
}
export interface InFlightTask {
    key: string;
    kind: TaskKind;
    label?: string;
    agent?: string;
    startedAt: string;
    ageMs: number;
}
export declare class TaskPool {
    limits: TaskPoolLimits;
    private readonly tasks;
    onChange: (() => void) | null;
    constructor(limits: TaskPoolLimits);
    private changed;
    has(key: string): boolean;
    count(kind: TaskKind): number;
    total(): number;
    canStart(kind: TaskKind): boolean;
    reserve(key: string, kind: TaskKind, run: () => Promise<void>, label?: string, agent?: string): boolean;
    list(): InFlightTask[];
    waitForAny(): Promise<void>;
    /**
     * Inter-cycle wait: sleep the full interval, but wake early when a pooled
     * agent finishes. A bare `Promise.race([pool.waitForAny(), sleep(ms)])`
     * resolves instantly on an empty pool (waitForAny is pre-resolved), which
     * hot-spins the loop whenever nothing is in flight — so the pool side only
     * joins the race when it is non-empty.
     */
    waitForPoolOrTimeout(ms: number, signal?: AbortSignal): Promise<void>;
    drain(timeoutMs: number, sliceMs: number): Promise<void>;
}
