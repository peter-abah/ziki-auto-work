import type { ProfileConfig, WorkflowConfig } from "./types.js";
export declare function effectiveProtectedFiles(profile: ProfileConfig): string[];
export declare function formatProtectedFiles(profile: ProfileConfig): string;
export declare function workflow(profile: ProfileConfig): WorkflowConfig;
export declare function formatWorkflowRules(profile: ProfileConfig, options?: {
    branch?: string;
}): string;
export declare function loadPrTemplateText(profile: ProfileConfig): Promise<string>;
export declare function formatPrFieldMap(): string;
