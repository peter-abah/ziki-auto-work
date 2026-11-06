import type { Logger } from "./log.js";
/** Minimal durable record so a later start can pick up where bootstrap left off. */
export interface BootstrapState {
    version: 1;
    at: string;
    profile: string | null;
    reason: string;
    keyEnvName: string | null;
    escalationId: string | null;
    escalationAnswer: string | null;
    escalationResolvedAt: string | null;
}
export declare function bootstrapDir(profileName?: string | null): string;
export declare function bootstrapFile(profileName?: string | null): string;
export declare function bootstrapNeedsFile(profileName?: string | null): string;
export declare function buildEscalationBody(reason: string, profileName: string | null, options?: {
    reasonSlice?: number;
}): string;
export declare function buildNeedsHumanBody(options: {
    reason: string;
    profileName: string | null;
    keyEnvName: string | null;
    escalationId: string | null;
    escalationAnswer: string | null;
}): string;
export interface BootstrapOptions {
    profileName?: string | null;
    reason: unknown;
    logger?: Logger;
}
export interface BootstrapResult {
    /** True when a Ziki escalation was filed (a human can answer there). */
    escalated: boolean;
    escalationId: string | null;
    keyEnvName: string | null;
    needsHumanFile: string;
}
/**
 * Startup fallback when the config is missing or invalid and the loop cannot
 * even boot. Degrades gracefully, step by step:
 * 1. Try a previously filed escalation first (adopt any human answer).
 * 2. Else try ONE validated env-file key to file a fresh escalation on Ziki.
 * 3. Always: write NEEDS-HUMAN.md, desktop notification, and console guidance.
 * Never writes keys anywhere, never probes beyond one read-only validation
 * per key, never invents configuration.
 */
export declare function bootstrapOnConfigFailure(options: BootstrapOptions): Promise<BootstrapResult>;
