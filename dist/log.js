import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(options) {
    const file = path.join(options.logDir, `${options.name}.log`);
    const threshold = LEVELS[options.level ?? "info"] ?? 20;
    let ready = null;
    const ensure = () => {
        if (!ready)
            ready = mkdir(options.logDir, { recursive: true });
        return ready;
    };
    const write = async (level, message, fields = {}) => {
        if ((LEVELS[level] ?? 20) < threshold)
            return;
        const entry = {
            ts: new Date().toISOString(),
            level,
            name: options.name,
            message,
            ...fields
        };
        await ensure();
        await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
        if (options.foreground !== false) {
            const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
            const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
            stream.write(`[${entry.ts}] ${level.toUpperCase()} ${message}${suffix}\n`);
        }
    };
    return {
        file,
        debug: (message, fields) => write("debug", message, fields),
        info: (message, fields) => write("info", message, fields),
        warn: (message, fields) => write("warn", message, fields),
        error: (message, fields) => write("error", message, fields),
        child: (name) => createLogger({
            name: `${options.name}.${name}`,
            logDir: options.logDir,
            foreground: options.foreground,
            level: options.level
        })
    };
}
export function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
export function truncate(text, max = 400) {
    if (text === undefined || text === null)
        return "";
    const value = String(text).replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
//# sourceMappingURL=log.js.map