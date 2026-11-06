import type { IdeaPolicyConfig } from "./types.js";
export interface IdeaSanitizePolicy {
    summaryMin?: number;
    suffix?: string;
    summaryMax?: number;
    titleMax?: number;
    descriptionMax?: number;
    fallback?: string;
}
export declare function ideaPolicyLimits(policy: IdeaSanitizePolicy | IdeaPolicyConfig | null | undefined): {
    titleMax: number;
    descriptionMax: number;
};
export declare function sanitizeIdeaSummary(value: unknown, fallback?: string, policy?: IdeaSanitizePolicy | IdeaPolicyConfig | null | undefined): string;
