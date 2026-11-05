import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { mutexFor } from "./mutex.js";
import { emptyUsage } from "./usage.js";
import { emptyHealth } from "./health.js";
export function emptyState() {
    return {
        version: 1,
        profile: null,
        startedAt: null,
        stoppedAt: null,
        lastCycleAt: null,
        lastCycleMs: null,
        cycles: 0,
        tasks: {},
        escalations: {},
        noteDedupe: {},
        recentFeedKeys: {},
        counters: {},
        memory: { lastContextLoad: null },
        feedEtags: {},
        apiContracts: {},
        lastError: null,
        run: {
            startedAt: null,
            limits: null,
            stopReason: null,
            startedCycles: 0,
            deliveries: 0,
            reviews: 0,
            mergeReviews: 0,
            discoveries: 0,
            aux: 0,
            failures: 0,
            networkErrors: 0,
            tokens: emptyUsage()
        },
        lastCycle: null,
        lastRun: null,
        activePids: [],
        health: emptyHealth()
    };
}
function todayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}
export async function loadState(profilePaths) {
    if (!existsSync(profilePaths.stateFile))
        return emptyState();
    try {
        const parsed = JSON.parse(await readFile(profilePaths.stateFile, "utf8"));
        const base = emptyState();
        return {
            ...base,
            ...parsed,
            run: { ...base.run, ...(parsed.run ?? {}) },
            health: parsed.health ? { ...base.health, ...parsed.health, blockers: parsed.health.blockers ?? {} } : base.health
        };
    }
    catch {
        return emptyState();
    }
}
export async function saveState(profilePaths, state) {
    const lock = mutexFor(`state:${profilePaths.stateFile}`);
    await lock.run(async () => {
        await mkdir(profilePaths.stateDir, { recursive: true });
        const tmp = `${profilePaths.stateFile}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await rename(tmp, profilePaths.stateFile);
    });
}
const HISTORY_CAP_BYTES = 5 * 1024 * 1024;
export async function appendHistory(profilePaths, entry) {
    const lock = mutexFor(`history:${profilePaths.historyFile}`);
    await lock.run(async () => {
        await mkdir(profilePaths.stateDir, { recursive: true });
        await appendFile(profilePaths.historyFile, `${JSON.stringify(entry)}\n`, "utf8");
        const info = await stat(profilePaths.historyFile).catch(() => null);
        if (info && info.size > HISTORY_CAP_BYTES) {
            const text = await readFile(profilePaths.historyFile, "utf8");
            const lines = text.trimEnd().split("\n");
            const keep = lines.slice(Math.floor(lines.length / 2));
            await writeFile(profilePaths.historyFile, `${keep.join("\n")}\n`, "utf8");
        }
    });
}
export async function readHistory(profilePaths, limit = 50) {
    if (!existsSync(profilePaths.historyFile))
        return [];
    const text = await readFile(profilePaths.historyFile, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const entries = [];
    for (const line of lines.slice(-Math.max(limit, 1))) {
        try {
            entries.push(JSON.parse(line));
        }
        catch {
            // skip malformed line
        }
    }
    return entries;
}
export function counterFor(state, date = new Date()) {
    const key = todayKey(date);
    state.counters[key] ??= { deliveries: 0, reviews: 0, discoveries: 0, aux: 0, errors: 0 };
    return state.counters[key];
}
export function pruneState(state, { keepDays = 14 } = {}) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const [key, value] of Object.entries(state.recentFeedKeys)) {
        if (value < cutoff)
            delete state.recentFeedKeys[key];
    }
    for (const [key, value] of Object.entries(state.noteDedupe)) {
        if (value < cutoff)
            delete state.noteDedupe[key];
    }
    for (const [key] of Object.entries(state.counters)) {
        if (new Date(`${key}T00:00:00Z`).getTime() < cutoff)
            delete state.counters[key];
    }
    return state;
}
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export async function acquireLock(profilePaths) {
    await mkdir(profilePaths.stateDir, { recursive: true });
    if (existsSync(profilePaths.lockFile)) {
        const raw = await readFile(profilePaths.lockFile, "utf8").catch(() => "");
        const pid = Number(raw.trim());
        if (pid && isAlive(pid))
            return { acquired: false, pid };
        await unlink(profilePaths.lockFile).catch(() => { });
    }
    await writeFile(profilePaths.lockFile, String(process.pid), "utf8");
    return { acquired: true, pid: process.pid };
}
export async function releaseLock(profilePaths) {
    const raw = await readFile(profilePaths.lockFile, "utf8").catch(() => "");
    if (Number(raw.trim()) === process.pid) {
        await unlink(profilePaths.lockFile).catch(() => { });
    }
}
export async function readPid(profilePaths) {
    const raw = await readFile(profilePaths.pidFile, "utf8").catch(() => "");
    const pid = Number(raw.trim());
    return pid && isAlive(pid) ? pid : null;
}
export async function writePid(profilePaths, pid) {
    await mkdir(profilePaths.stateDir, { recursive: true });
    await writeFile(profilePaths.pidFile, String(pid), "utf8");
}
export async function clearPid(profilePaths) {
    await unlink(profilePaths.pidFile).catch(() => { });
}
export async function setPaused(profilePaths, paused) {
    if (paused) {
        await mkdir(profilePaths.stateDir, { recursive: true });
        await writeFile(profilePaths.pauseFile, new Date().toISOString(), "utf8");
    }
    else {
        await unlink(profilePaths.pauseFile).catch(() => { });
    }
}
export async function isPaused(profilePaths) {
    return existsSync(profilePaths.pauseFile);
}
export async function setStopped(profilePaths, stopped) {
    if (stopped) {
        await mkdir(profilePaths.stateDir, { recursive: true });
        await writeFile(profilePaths.stopFile, new Date().toISOString(), "utf8");
    }
    else {
        await unlink(profilePaths.stopFile).catch(() => { });
    }
}
export async function isStopped(profilePaths) {
    return existsSync(profilePaths.stopFile);
}
export function taskKey(issue) {
    return issue?.id || String(issue?.number ?? "");
}
export function getTask(state, issue) {
    return state.tasks[taskKey(issue)] ?? null;
}
export function setTask(state, issue, patch) {
    const key = taskKey(issue);
    const previous = state.tasks[key] ??
        {
            id: issue?.id ?? null,
            number: issue?.number ?? null,
            title: issue?.title ?? null,
            status: "queued",
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    state.tasks[key] = { ...previous, ...patch, updatedAt: new Date().toISOString() };
    return state.tasks[key];
}
//# sourceMappingURL=state.js.map