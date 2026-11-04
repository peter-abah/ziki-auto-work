import type { ProfileConfig, ProviderAdapter, ProviderCommand, ProviderName } from "../types.js";
export declare function getProvider(name: ProviderName, profile: ProfileConfig): ProviderAdapter;
export declare function providerCommand(profile: ProfileConfig, input: {
    prompt: string;
    cwd: string;
    resultPath: string;
    model: string | null;
}): ProviderCommand;
