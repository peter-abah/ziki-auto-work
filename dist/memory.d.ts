import type { ProfilePaths, State } from "./types.js";
import type { ZikiClient } from "./ziki.js";
export interface MemoryContext {
    loadedAt: string;
    agent: {
        name: string;
        level: string;
        instructions: string | null;
    } | null;
    projectNotes: {
        body?: string;
        version?: number;
    } | null;
    notesComments: Array<{
        body: string;
        authorName?: string;
        by?: string;
        createdAt?: string;
    }>;
    ownNotes: Array<{
        id: string;
        body: string;
        createdAt: string;
    }>;
    mistakes: Array<Record<string, unknown>>;
    fromCache?: boolean;
}
export declare function readCachedMemory(profilePaths: ProfilePaths): Promise<MemoryContext | null>;
export declare function writeCachedMemory(profilePaths: ProfilePaths, memory: MemoryContext): Promise<void>;
export declare function loadMemoryContext(client: ZikiClient, profilePaths: ProfilePaths, options?: {
    maxAgeMinutes?: number;
    force?: boolean;
}): Promise<MemoryContext>;
export declare function formatMemoryForPrompt(memory: MemoryContext | null, maxChars?: number): string;
export declare function learningKey(issue: {
    id?: string | null;
    number?: number | string | null;
} | null, outcome: string): string;
export declare function recordLearning(client: ZikiClient, options: {
    issue: {
        id?: string | null;
        number?: number | string | null;
        title?: string | null;
    } | null;
    outcome: string;
    summary?: string;
    details?: string;
    shared?: boolean;
    state?: State | null;
    agentName?: string;
}): Promise<{
    skipped?: boolean;
    key: string;
    privateNote?: unknown;
    sharedComment?: unknown;
}>;
export declare function recordTaskNote(client: ZikiClient, task: {
    id?: string | null;
    number?: number | string | null;
    title?: string | null;
}, outcome: string, summary: string | undefined, details: string | undefined, state: State | null, agentName: string): Promise<{
    skipped?: boolean;
    key: string;
    privateNote?: unknown;
    sharedComment?: unknown;
}>;
