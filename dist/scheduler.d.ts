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
    constructor(limits: TaskPoolLimits);
    has(key: string): boolean;
    count(kind: TaskKind): number;
    total(): number;
    canStart(kind: TaskKind): boolean;
    reserve(key: string, kind: TaskKind, run: () => Promise<void>, label?: string, agent?: string): boolean;
    list(): InFlightTask[];
    waitForAny(): Promise<void>;
    drain(timeoutMs?: number): Promise<void>;
}
