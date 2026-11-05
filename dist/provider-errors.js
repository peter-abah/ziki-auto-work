export function normalizeProviderLimit(value) {
    return value === "quota" || value === "rate-limit" || value === "context" ? value : null;
}
export function providerLimitForResult(parsed, failed) {
    if (!failed)
        return null;
    return normalizeProviderLimit(parsed?.providerLimit);
}
//# sourceMappingURL=provider-errors.js.map