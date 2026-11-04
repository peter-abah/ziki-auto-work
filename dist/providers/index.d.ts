import type { ProfileConfig, ProviderAdapter, ProviderCommand, ProviderName } from "../types.js";
export declare const BUILTIN_PROVIDERS: ProviderName[];
export declare const SHORTLIST_PROVIDER_IDS: string[];
export declare const PROVIDER_IDS: string[];
export declare function getProvider(name: ProviderName, profile: ProfileConfig): ProviderAdapter;
export declare function listProviderIds(profile?: ProfileConfig | null): string[];
export declare function providerCommand(profile: ProfileConfig, input: {
    prompt: string;
    cwd: string;
    resultPath: string;
    model: string | null;
}): ProviderCommand;
