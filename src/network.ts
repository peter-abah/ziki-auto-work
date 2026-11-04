const NETWORK_PATTERNS: RegExp[] = [
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

export function isTransientNetworkText(text: string | null | undefined): boolean {
  if (!text) return false;
  return NETWORK_PATTERNS.some((pattern) => pattern.test(text));
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ""}`;
  return String(error ?? "");
}

export function isTransientNetworkError(error: unknown): boolean {
  const record = error as { code?: unknown; status?: unknown } | null;
  if (record?.status === 502 || record?.status === 503 || record?.status === 504) return true;
  if (typeof record?.code === "string" && isTransientNetworkText(record.code)) return true;
  return isTransientNetworkText(errorText(error));
}

export async function retryNetwork<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; shouldRetry?: (error: unknown) => boolean } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseMs = options.baseMs ?? 500;
  const shouldRetry = options.shouldRetry ?? isTransientNetworkError;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !shouldRetry(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, baseMs * 2 ** attempt)));
    }
  }
  throw lastError;
}
