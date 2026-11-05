export interface DiscoveryContextOptions {
    parityFile?: string | null;
    contextFiles?: string[];
    repoDir: string;
    packageRoot: string;
}
export interface DiscoveryContext {
    parity: string;
    context: string;
    missing: string[];
}
export declare function contextCandidates(file: string, repoDir: string, packageRoot: string): string[];
export declare function loadDiscoveryContext(options: DiscoveryContextOptions): Promise<DiscoveryContext>;
