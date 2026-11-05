export type DeploymentEnvironment = "dev" | "staging" | "prod";
export declare function deploymentEnvironment(key: string): DeploymentEnvironment | null;
export declare function workTargetKey(key: string, issueId?: string | null, ideaId?: string | null): string;
