export function sanitizeIdeaSummary(value, fallback = "") {
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
    if (text.length < 20)
        text = `${text} — desktop parity gap.`.trim();
    return text.slice(0, 300);
}
//# sourceMappingURL=idea-input.js.map