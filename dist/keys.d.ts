import type { PlatformRef } from "./types.js";
export interface KeyProject {
    id: string;
    slug: string;
    name: string;
}
export interface KeyInspection {
    envName: string;
    key: string;
    ok: boolean;
    agent?: string;
    level?: string;
    projectId?: string;
    projectSlug?: string;
    projectName?: string;
    projects?: KeyProject[];
    error?: string;
}
export declare function inspectKey(envName: string, key: string, baseUrl?: string): Promise<KeyInspection>;
export declare function inspectKeys(env: Record<string, string>, baseUrl?: string): Promise<KeyInspection[]>;
export declare function assignRoles(items: KeyInspection[]): {
    workers: string[];
    managers: string[];
};
export declare function formatKeyTable(items: KeyInspection[]): string;
export declare function projectSummary(items: KeyInspection[]): {
    id: string;
    slug: string;
    name?: string;
} | null;
export declare function knownProjects(items: KeyInspection[]): KeyProject[];
export declare function listPlatforms(baseUrl: string, key: string): Promise<PlatformRef[]>;
