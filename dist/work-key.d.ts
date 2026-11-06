import type { UrlsPolicyConfig } from "./types.js";
export type DeploymentEnvironment = "dev" | "staging" | "prod";
export declare function deploymentEnvironment(key: string, policy?: UrlsPolicyConfig | null | undefined): DeploymentEnvironment | null;
export declare function workTargetKey(key: string, issueId?: string | null, ideaId?: string | null): string;
