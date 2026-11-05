import type { EscalationRecord, EscalationType, Issue, ProfileConfig, ProfilePaths, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";
import type { Logger } from "./log.js";
export declare function openEscalations(state: State): EscalationRecord[];
export declare function escalate(client: ZikiClient, profile: ProfileConfig, profilePaths: ProfilePaths, state: State, options: {
    issue?: Issue | null;
    type?: EscalationType;
    body: string;
    agentName?: string;
    logger?: Logger;
    notifyCommand?: string | null;
    maxOpen?: number | null;
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
export declare function writeNeedsHuman(state: State, profile: ProfileConfig, profilePaths: ProfilePaths): Promise<void>;
