import type { RunLimitConfig, State } from "./types.js";
export type LimitReason = "max-cycles" | "max-deliveries" | "until" | "max-runtime";
export declare function cyclesThisRun(state: State): number;
export declare function remainingCycles(state: State, maxCycles: number | null): number | null;
export declare function limitReached(state: State, limits: RunLimitConfig, now?: number): LimitReason | null;
