import type { AgentResult, Issue, ProfileConfig } from "./types.js";
import type { PrBodyInput } from "./github.js";
export declare function preparePrBody(input: {
    profile: ProfileConfig;
    issue: Issue;
    result: AgentResult;
    fallback: PrBodyInput;
}): Promise<{
    body: string;
    source: "agent" | "fallback";
    reason?: string;
}>;
