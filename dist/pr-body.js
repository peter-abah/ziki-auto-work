import { buildPrBody } from "./github.js";
import { scanSecretsText } from "./checks.js";
import { issueUrl } from "./urls.js";
function unwrapFence(value) {
    const text = value.trim();
    const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    return match ? match[1].trim() : text;
}
function maxBodyChars(profile) {
    const value = profile.pr?.maxBodyChars;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error("profile.pr.maxBodyChars must be a positive integer (run `auto-work migrate`)");
    }
    return value;
}
function fallbackReason(value, profile) {
    if (!value)
        return "empty";
    if (value.length > maxBodyChars(profile))
        return `too long (${value.length} chars)`;
    if (/\{\{[a-zA-Z0-9_]+\}\}/.test(value))
        return "unresolved placeholders";
    if (scanSecretsText(value, profile.safety?.secretPatterns).length)
        return "possible secret";
    return null;
}
export async function preparePrBody(input) {
    const agentBody = unwrapFence(typeof input.result.prBody === "string" ? input.result.prBody : "");
    const reason = fallbackReason(agentBody, input.profile);
    if (!reason) {
        const ticket = issueUrl(input.profile, input.issue);
        const body = agentBody.includes(ticket) || agentBody.includes(`#${input.issue.number}`)
            ? agentBody
            : `Ziki: ${ticket}\n\n${agentBody}`;
        return { body, source: "agent" };
    }
    return {
        body: await buildPrBody(input.profile, input.fallback),
        source: "fallback",
        reason
    };
}
//# sourceMappingURL=pr-body.js.map