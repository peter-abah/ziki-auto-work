import type { Config, ConfigPatchOp, EscalationRecord, HealthBlocker, ProfileConfig, ProfilePaths, ProjectSummary, RepairConfig, RepairStrategyConfig, State } from "./types.js";
import type { InitTemplates } from "./config-templates.js";
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
    /** Patch ops for identity fields that differ from the profile (may be empty). */
    ops: ConfigPatchOp[];
    /** Human-readable diagnosis summary. */
    detail: string;
    /**
     * The project's workUrl when it did not parse as /{org}/{project}/work.
     * Signals a URL-shape change: never guess from it, ask the owner instead.
     */
    unparsedWorkUrl: string | null;
}
/**
 * Live diagnosis: list the tenant's projects, match a replacement, read it
 * back and diff every identity field (projectId, projectSlug, orgSlug from
 * workUrl) against the profile. Read-only; proposes only what differs.
 */
export declare function diagnoseProjectMismatch(client: ZikiClient, profile: ProfileConfig, logger?: Logger): Promise<ProjectDiagnosis>;
export interface MissingKeyDiagnosis {
    ops: ConfigPatchOp[];
    summary: string;
}
/**
 * Deterministic missing-key repair: diff the live profile against init
 * templates (the same fill `migrate`/`loadProfile` apply) and propose
 * exactly the absent paths. No agent needed; the human approves the values.
 */
export declare function diagnoseMissingKeys(profile: ProfileConfig, templates: InitTemplates): MissingKeyDiagnosis;
export interface UnknownKindDiagnosis {
    ops: ConfigPatchOp[];
    summary: string;
}
/**
 * Deterministic unknown-kind repair: a Ziki work kind the queue has never
 * seen. Proposed into the aux bucket with priority after every known kind
 * (visible, never silently dropped); the human moves it to owner/work/review
 * if triage says otherwise.
 */
export declare function diagnoseUnknownKind(kind: string, profile: ProfileConfig): UnknownKindDiagnosis;
export interface UnknownVocabularyDiagnosis {
    ops: ConfigPatchOp[];
    summary: string;
}
/**
 * Deterministic unknown-vocabulary repair: append unseen Ziki statuses or
 * substatuses to statuses.known ONLY (drift vocabulary — never redefines
 * what counts as done; workable/terminal lists stay human-owned).
 */
export declare function diagnoseUnknownVocabulary(values: string[], profile: ProfileConfig): UnknownVocabularyDiagnosis;
export interface UnknownEndpointDiagnosis {
    ops: ConfigPatchOp[];
    summary: string;
}
/**
 * Deterministic unknown-endpoint repair: an operations entry points at an
 * endpoint name missing from ziki.endpoints. If init templates know that
 * endpoint (config drift), propose the template value. If templates don't
 * know it either, Ziki added a route — a human must add the endpoint first
 * (agents never invent API routes).
 */
export declare function diagnoseUnknownEndpoint(group: string, name: string, profile: ProfileConfig, templates: InitTemplates): UnknownEndpointDiagnosis;
/** Parse "unknown endpoint: group.name" / "unknown operation: group.name" from a blocker message. */
export declare function parseUnknownEndpoint(message: string | null | undefined): {
    group: string;
    name: string;
} | null;
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
/**
 * Supersede check: returns the newly covered paths when the fresh diagnosis is
 * a strict superset of the pending proposal (monotonic growth guarantees the
 * escalation chain terminates), else null. Pure function — extracted for testing.
 */
export declare function supersedingPaths(existing: ConfigPatchOp[] | null | undefined, fresh: ConfigPatchOp[] | null | undefined): string[] | null;
