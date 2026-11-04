import type { ProfileConfig } from "./types.js";
export declare function toolchainDirs(profile: ProfileConfig): string[];
export declare function toolchainPath(profile: ProfileConfig, base?: string): string;
export declare function buildAgentEnv(profile: ProfileConfig, providerEnv: Record<string, string> | undefined, extraEnv: Record<string, string> | undefined): Record<string, string>;
export declare function buildCheckEnv(profile: ProfileConfig, checkEnv: Record<string, string> | undefined): Record<string, string>;
export declare function envFilesFor(profile: ProfileConfig): string[];
