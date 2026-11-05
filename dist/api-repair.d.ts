import type { ApiContractStore } from "./types.js";
export declare function contractKey(method: string, pathname: string): string;
export declare function stripRejectedFields(body: unknown, rejected: ReadonlyArray<string>): unknown;
export declare function recordRejected(contracts: ApiContractStore, key: string, rejected: ReadonlyArray<string>): void;
export declare function repairApiBody(body: unknown, errorBody: unknown): {
    body: unknown;
    changed: boolean;
    rejected: string[];
} | null;
export declare function formatApiErrorDetails(errorBody: unknown): string;
