import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { JobPaths, State, TaskState } from "./types.js";

export function emptyState(): State {
  return {
    version: 1,
    job: null,
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
    baselineFailures: {},
    baselineSha: null,
    baselineAt: null,
    lastError: null
  };
}

function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function loadState(jobPaths: JobPaths): Promise<State> {
  if (!existsSync(jobPaths.stateFile)) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(jobPaths.stateFile, "utf8")) as Partial<State>;
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export async function saveState(jobPaths: JobPaths, state: State): Promise<void> {
  await mkdir(jobPaths.stateDir, { recursive: true });
  const tmp = `${jobPaths.stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, jobPaths.stateFile);
}

export function counterFor(state: State, date = new Date()): State["counters"][string] {
  const key = todayKey(date);
  state.counters[key] ??= { deliveries: 0, reviews: 0, discoveries: 0, aux: 0, errors: 0 };
  return state.counters[key]!;
}

export function pruneState(state: State, { keepDays = 14 } = {}): State {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(state.recentFeedKeys)) {
    if (value < cutoff) delete state.recentFeedKeys[key];
  }
  for (const [key, value] of Object.entries(state.noteDedupe)) {
    if (value < cutoff) delete state.noteDedupe[key];
  }
  for (const [key] of Object.entries(state.counters)) {
    if (new Date(`${key}T00:00:00Z`).getTime() < cutoff) delete state.counters[key];
  }
  return state;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(jobPaths: JobPaths): Promise<{ acquired: boolean; pid: number }> {
  await mkdir(jobPaths.stateDir, { recursive: true });
  if (existsSync(jobPaths.lockFile)) {
    const raw = await readFile(jobPaths.lockFile, "utf8").catch(() => "");
    const pid = Number(raw.trim());
    if (pid && isAlive(pid)) return { acquired: false, pid };
    await unlink(jobPaths.lockFile).catch(() => {});
  }
  await writeFile(jobPaths.lockFile, String(process.pid), "utf8");
  return { acquired: true, pid: process.pid };
}

export async function releaseLock(jobPaths: JobPaths): Promise<void> {
  const raw = await readFile(jobPaths.lockFile, "utf8").catch(() => "");
  if (Number(raw.trim()) === process.pid) {
    await unlink(jobPaths.lockFile).catch(() => {});
  }
}

export async function readPid(jobPaths: JobPaths): Promise<number | null> {
  const raw = await readFile(jobPaths.pidFile, "utf8").catch(() => "");
  const pid = Number(raw.trim());
  return pid && isAlive(pid) ? pid : null;
}

export async function writePid(jobPaths: JobPaths, pid: number): Promise<void> {
  await mkdir(jobPaths.stateDir, { recursive: true });
  await writeFile(jobPaths.pidFile, String(pid), "utf8");
}

export async function clearPid(jobPaths: JobPaths): Promise<void> {
  await unlink(jobPaths.pidFile).catch(() => {});
}

export async function setPaused(jobPaths: JobPaths, paused: boolean): Promise<void> {
  if (paused) {
    await mkdir(jobPaths.stateDir, { recursive: true });
    await writeFile(jobPaths.pauseFile, new Date().toISOString(), "utf8");
  } else {
    await unlink(jobPaths.pauseFile).catch(() => {});
  }
}

export async function isPaused(jobPaths: JobPaths): Promise<boolean> {
  return existsSync(jobPaths.pauseFile);
}

export async function setStopped(jobPaths: JobPaths, stopped: boolean): Promise<void> {
  if (stopped) {
    await mkdir(jobPaths.stateDir, { recursive: true });
    await writeFile(jobPaths.stopFile, new Date().toISOString(), "utf8");
  } else {
    await unlink(jobPaths.stopFile).catch(() => {});
  }
}

export async function isStopped(jobPaths: JobPaths): Promise<boolean> {
  return existsSync(jobPaths.stopFile);
}

export function taskKey(issue: { id?: string | null; number?: number | string | null } | null | undefined): string {
  return issue?.id || String(issue?.number ?? "");
}

export function getTask(state: State, issue: { id?: string | null; number?: number | string | null }): TaskState | null {
  return state.tasks[taskKey(issue)] ?? null;
}

export function setTask(
  state: State,
  issue: { id?: string | null; number?: number | string | null; title?: string | null },
  patch: Partial<TaskState>
): TaskState {
  const key = taskKey(issue);
  const previous: TaskState =
    state.tasks[key] ??
    ({
      id: issue?.id ?? null,
      number: issue?.number ?? null,
      title: issue?.title ?? null,
      status: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } satisfies TaskState);
  state.tasks[key] = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  return state.tasks[key]!;
}
