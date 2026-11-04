export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
    file: string;
    debug: (message: string, fields?: Record<string, unknown>) => Promise<void>;
    info: (message: string, fields?: Record<string, unknown>) => Promise<void>;
    warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
    error: (message: string, fields?: Record<string, unknown>) => Promise<void>;
    child: (name: string) => Logger;
}
export declare function createLogger(options: {
    name: string;
    logDir: string;
    foreground?: boolean;
    level?: LogLevel;
}): Logger;
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
export declare function truncate(text: unknown, max?: number): string;
