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
export declare class TaskPool {
    limits: TaskPoolLimits;
    private readonly tasks;
    constructor(limits: TaskPoolLimits);
    has(key: string): boolean;
    count(kind: TaskKind): number;
    total(): number;
    canStart(kind: TaskKind): boolean;
    reserve(key: string, kind: TaskKind, run: () => Promise<void>): boolean;
    list(): Array<{
        key: string;
        kind: TaskKind;
        startedAt: string;
        ageMs: number;
    }>;
    waitForAny(): Promise<void>;
    drain(timeoutMs?: number): Promise<void>;
}
