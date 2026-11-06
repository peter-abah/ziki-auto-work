import type { Config, ConfigPatchOp, EscalationRecord, HealthBlocker, ProfileConfig, ProfilePaths, ProjectSummary, RepairConfig, RepairStrategyConfig, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";
import type { Logger } from "./log.js";
export declare const PROJECT_NOT_FOUND_MESSAGE = "Project not found.";
/** True only for the retired-project signature — not for any other 404 (e.g. a renamed route). */
export declare function isProjectNotFoundBlocker(code: string, message: string | null | undefined): boolean;
/** Approvals inbox for `auto-work approve` (loop consumes, then truncates). */
export declare function approvalsFile(profilePaths: ProfilePaths): string;
export interface LocalApproval {
    id: string;
    decision: "approved" | "rejected";
    note?: string | null;
    at: string;
}
export declare function readLocalApprovals(profilePaths: ProfilePaths): Promise<LocalApproval[]>;
export declare function consumeLocalApprovals(profilePaths: ProfilePaths): Promise<LocalApproval[]>;
export declare function queueLocalApproval(profilePaths: ProfilePaths, approval: LocalApproval): Promise<void>;
/** Merged repair config: profile values over built-in defaults. */
export declare function repairConfigFor(profile: ProfileConfig): Required<RepairConfig>;
export declare function strategyFor(profile: ProfileConfig, code: string): RepairStrategyConfig | null;
export declare function maxRoundsFor(strategy: RepairStrategyConfig | null): number;
export declare function blockerCode(blocker: HealthBlocker | null | undefined): string | null;
export interface ProjectMatch {
    project: ProjectSummary;
    reason: string;
}
/**
 * Match a replacement project: exact slug match on the profile platform
 * first, then repo owner/name match as a fallback. Pure function.
 */
export declare function matchReplacementProject(projects: ProjectSummary[], profile: ProfileConfig): {
    project: ProjectSummary;
    reason: string;
} | {
    ambiguous: ProjectSummary[];
} | null;
export interface ProjectDiagnosis {
    projects: ProjectSummary[];
    match: ProjectMatch | null;
    ambiguous: ProjectSummary[] | null;
}
/** Live diagnosis: list the tenant's projects and match a replacement. Read-only. */
export declare function diagnoseProjectMismatch(client: ZikiClient, profile: ProfileConfig, logger?: Logger): Promise<ProjectDiagnosis>;
/** Build the patch ops for adopting a replacement project. */
export declare function projectRotationPatch(project: ProjectSummary, reason: string): ConfigPatchOp[];
export interface FilterDiagnosis {
    platforms: Array<{
        slug?: string | null;
        name?: string | null;
    }>;
    current: string | undefined;
    resolves: boolean;
    suggested: ConfigPatchOp[];
    reason: string;
}
/**
 * Diagnose an unknown platform/area filter: list the tenant's current
 * platforms and see whether the configured filter still resolves. Read-only.
 * Shapes are defensive — the endpoint is newer than any pinned contract.
 */
export declare function diagnoseUnknownFilter(client: ZikiClient, profile: ProfileConfig, logger?: Logger): Promise<FilterDiagnosis>;
export interface ApplyResult {
    ok: boolean;
    backupFile?: string;
    errors?: string[];
}
/**
 * Validate and persist an approved patch: allowlist check, type check, full
 * config validation on the merged result, timestamped backup, atomic save.
 * Pure file operation — never touches Ziki or agents.
 */
export declare function applyConfigPatch(config: Config, profileName: string, profilePaths: ProfilePaths, ops: ConfigPatchOp[], logger?: Logger): Promise<ApplyResult>;
/** Escalation body for a config-repair proposal. */
export declare function formatRepairEscalationBody(options: {
    strategy: string;
    failureMessage: string;
    summary: string;
    ops: ConfigPatchOp[];
    evidence: string[];
    round: number;
    previousAnswer?: string | null;
}): string;
/** Latest open config escalation for a strategy (reaps local CLI approvals first). */
export declare function latestStrategyEscalation(state: State, strategy: string): EscalationRecord | null;
