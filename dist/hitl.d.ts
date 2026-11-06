import type { ConfigPatchOp, EscalationRecord, EscalationType, Issue, ProfileConfig, ProfilePaths, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";
import type { Logger } from "./log.js";
/**
 * Human-approval convention for config-repair escalations (shared with the
 * NEEDS-HUMAN rendering and the CLI): a Ziki answer or CLI note starting
 * with APPROVE (case-insensitive) approves the proposed patch; a dismissed
 * escalation rejects it; anything else keeps the discussion open and the
 * agent must re-escalate with a revised proposal.
 */
export declare const APPROVAL_WORD = "APPROVE";
export declare function isApprovalText(text: string | null | undefined): boolean;
export type ConfigDecision = "approved" | "rejected" | "needs_info";
/** Interpret a human answer on a config escalation. Never throws. */
export declare function interpretHumanAnswer(remoteStatus: "open" | "resolved" | "dismissed", resolution: string | null | undefined): ConfigDecision | null;
export declare function openEscalations(state: State): EscalationRecord[];
export declare function escalate(client: ZikiClient, profile: ProfileConfig, profilePaths: ProfilePaths, state: State, options: {
    issue?: Issue | null;
    type?: EscalationType;
    body: string;
    agentName?: string;
    logger?: Logger;
    notifyCommand?: string | null;
    maxOpen?: number | null;
    kind?: "issue" | "config";
    strategy?: string | null;
    configPatch?: ConfigPatchOp[] | null;
    previousId?: string | null;
    rounds?: number | null;
}): Promise<{
    ok: boolean;
    skipped?: boolean;
    escalation?: EscalationRecord;
    link?: string;
    error?: string;
}>;
export declare function poll(client: ZikiClient, profile: ProfileConfig, profilePaths: ProfilePaths, state: State, options?: {
    logger?: Logger;
    markInboxRead?: boolean;
    clientForName?: (name: string | null) => ZikiClient | null;
}): Promise<{
    resolved: EscalationRecord[];
    inbox?: unknown;
    errors: unknown[];
}>;
/**
 * Record a human answer on a loop-level config escalation WITHOUT closing
 * our workflow state, so clarifying messages stay in the loop:
 * - approved → decision set; the orchestrator applies the patch next cycle.
 * - rejected → terminal; the strategy is done for this failure episode.
 * - needs_info → the answer is stored and a revised proposal must be
 *   re-escalated (new record, rounds+1, previousId linked).
 */
export declare function applyRemoteAnswer(escalation: EscalationRecord, remoteStatus: "open" | "resolved" | "dismissed", resolution: string | null | undefined, logger?: Logger): ConfigDecision | null;
/** Local-CLI approval fallback (used by `auto-work approve` when Ziki is unreachable). */
export declare function approveEscalation(state: State, escalationId: string, note?: string | null): {
    ok: boolean;
    error?: string;
};
/** Local-CLI rejection (used by `auto-work reject`). */
export declare function rejectEscalation(state: State, escalationId: string, note?: string | null): {
    ok: boolean;
    error?: string;
};
/** Park an escalation whose proposal rounds are exhausted. */
export declare function markEscalationExpired(state: State, escalationId: string, reason: string): boolean;
/** Open config escalations for one repair strategy, oldest first. */
export declare function openConfigEscalations(state: State, strategy: string): EscalationRecord[];
export declare function writeNeedsHuman(state: State, profile: ProfileConfig, profilePaths: ProfilePaths): Promise<void>;
