function requirePolicy(policy) {
    if (!policy || typeof policy !== "object") {
        throw new Error("idea policy is required (run `auto-work migrate`)");
    }
    const { summaryMin, suffix, summaryMax, titleMax, descriptionMax, fallback } = policy;
    if (typeof summaryMin !== "number" || !Number.isFinite(summaryMin) || summaryMin < 0) {
        throw new Error("idea.summaryMin must be a non-negative number (run `auto-work migrate`)");
    }
    if (typeof suffix !== "string") {
        throw new Error("idea.suffix must be a string (run `auto-work migrate`)");
    }
    for (const [key, value] of [["summaryMax", summaryMax], ["titleMax", titleMax], ["descriptionMax", descriptionMax]]) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            throw new Error(`idea.${key} must be a positive number (run \`auto-work migrate\`)`);
        }
    }
    return {
        summaryMin,
        suffix,
        summaryMax: summaryMax,
        titleMax: titleMax,
        descriptionMax: descriptionMax,
        fallback: typeof fallback === "string" ? fallback : ""
    };
}
export function ideaPolicyLimits(policy) {
    const resolved = requirePolicy(policy);
    return { titleMax: resolved.titleMax, descriptionMax: resolved.descriptionMax };
}
export function sanitizeIdeaSummary(value, fallback = "", policy) {
    const resolved = requirePolicy(policy);
    const raw = String(value || fallback || "").trim();
    let text = raw
        .replace(/\]\(/g, " ")
        .replace(/[#*`>|]/g, " ")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    if (!text)
        text = "Desktop parity gap found by discovery.";
    if (text.length < resolved.summaryMin)
        text = `${text}${resolved.suffix}`.trim();
    return text.slice(0, resolved.summaryMax);
}
//# sourceMappingURL=idea-input.js.map