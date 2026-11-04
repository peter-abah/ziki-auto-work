import type { GitHubPrStatus, PrComment } from "./github.js";
export declare function formatPrContext(status: GitHubPrStatus, extraComments?: PrComment[], checkLogs?: Array<{
    name: string;
    log: string;
}>, maxChars?: number): string;
