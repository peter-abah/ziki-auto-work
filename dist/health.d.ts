import type { HealthBlocker, HealthComponent, HealthSeverity, HealthSummary, LoopHealth } from "./types.js";
export interface HealthReport {
    component: HealthComponent;
    code: string;
    severity: HealthSeverity;
    message: string;
    agents?: string[];
    details?: Record<string, unknown>;
    retryMs?: number | null;
}
export interface HealthUpdate {
    blocker: HealthBlocker;
    changed: boolean;
    created: boolean;
}
/**
 * Backoff for a blocker id from profile.health.retryMs. Lookup order:
 * exact id ("provider:quota") → wildcard code ("*:quota") → catch-all ("*").
 * Absent map or unmapped id fails loud — unknown backoff must surface as a
 * config gap, never a silent built-in. `null` means retry next cycle.
 */
export declare function retryMsFor(profile: {
    health?: {
        retryMs?: Record<string, number | null>;
    } | undefined;
} | null | undefined, blockerId: string): number | null;
export declare function emptyHealth(): LoopHealth;
export declare function summarizeHealth(health: LoopHealth): HealthSummary;
export declare function blockerId(component: HealthComponent, code: string): string;
export declare function classifyError(error: unknown, component: HealthComponent, profile?: {
    health?: {
        retryMs?: Record<string, number | null>;
    } | undefined;
} | null): HealthReport;
export declare function reportBlocker(health: LoopHealth, report: HealthReport, now?: number): HealthUpdate;
export declare function clearBlocker(health: LoopHealth, component: HealthComponent, code?: string): HealthBlocker[];
export declare function nextRetryDelay(health: LoopHealth, now?: number): number | null;
export declare function healthLabel(health: LoopHealth): string;
