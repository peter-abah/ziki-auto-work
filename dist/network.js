const NETWORK_PATTERNS = [
    /\bENOTFOUND\b/i,
    /\bEAI_AGAIN\b/i,
    /\bECONNRESET\b/i,
    /\bECONNREFUSED\b/i,
    /\bECONNABORTED\b/i,
    /\bETIMEDOUT\b/i,
    /\bEPIPE\b/i,
    /\bEHOSTUNREACH\b/i,
    /\bENETUNREACH\b/i,
    /network is unreachable/i,
    /temporary failure in name resolution/i,
    /could not resolve host/i,
    /connection (reset|refused|timed out|closed)/i,
    /error connecting to/i,
    /dial tcp/i,
    /i\/o timeout/i,
    /remote end hung up unexpectedly/i,
    /early EOF/i,
    /the remote end hung up/i,
    /tls handshake timeout/i,
    /ssl (error|connect error)/i,
    /operation timed out/i,
    /socket hang up/i,
    /rpc failed/i,
    /http (502|503|504)/i,
    /bad gateway/i,
    /service unavailable/i,
    /gateway timeout/i
];
export function isTransientNetworkText(text) {
    if (!text)
        return false;
    return NETWORK_PATTERNS.some((pattern) => pattern.test(text));
}
export function isTransientNetworkError(error) {
    const record = error;
    if (record?.status === 502 || record?.status === 503 || record?.status === 504)
        return true;
    if (record?.name === "TimeoutError")
        return true;
    for (const value of [record?.code, record?.cause?.code]) {
        if (typeof value === "string" && isTransientNetworkText(value))
            return true;
    }
    if (record?.cause?.name === "TimeoutError")
        return true;
    return false;
}
export async function retryNetwork(operation, options = {}) {
    const attempts = Math.max(1, options.attempts ?? 3);
    const baseMs = options.baseMs ?? 500;
    const shouldRetry = options.shouldRetry ?? isTransientNetworkError;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (attempt >= attempts - 1 || !shouldRetry(error))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, baseMs * 2 ** attempt)));
        }
    }
    throw lastError;
}
//# sourceMappingURL=network.js.map