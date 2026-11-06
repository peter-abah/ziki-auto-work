export interface DriftFinding {
    name: string;
    ok: boolean;
    detail: string;
}
/**
 * Morning/evening Ziki drift review, machine-checked: re-reads the live
 * tenant (platforms, project identity) and diffs it against the merged
 * profile. Read-only; findings tell the human (or the repair flow) exactly
 * what to update. Never writes config.
 */
export declare function runDriftCheck(profileName?: string): Promise<{
    ok: boolean;
    findings: DriftFinding[];
}>;
export declare function formatDrift(result: {
    ok: boolean;
    findings: DriftFinding[];
}): string;
