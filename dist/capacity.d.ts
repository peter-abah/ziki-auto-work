import type { CapacityLimit, ProfileConfig } from "./types.js";
export interface Capacity {
    workers: number;
    totalKeys: number;
    agentCeiling: number;
    delivery: number;
    review: number;
    aux: number;
    followup: number;
    activeClaims: number;
    discovery: number;
    owner: number;
}
export declare function resolveCapacity(profile: ProfileConfig, keys: {
    workers: unknown[];
    managers: unknown[];
}): Capacity;
export declare function underCap(count: number, cap: CapacityLimit | undefined): boolean;
