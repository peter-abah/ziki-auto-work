import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { ProfilePaths, State, TaskState } from "./types.js";

export function emptyState(): State {
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
    baselineFailures: {},
    baselineSha: null,
    baselineAt: null,
    lastError: null
  };
}

function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function loadState(profilePaths: ProfilePaths): Promise<State> {
  if (!existsSync(profilePaths.stateFile)) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(profilePaths.stateFile, "utf8")) as Partial<State>;
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export async function saveState(profilePaths: ProfilePaths, state: State): Promise<void> {
  await mkdir(profilePaths.stateDir, { recursive: true });
  const tmp = `${profilePaths.stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, profilePaths.stateFile);
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

export async function acquireLock(profilePaths: ProfilePaths): Promise<{ acquired: boolean; pid: number }> {
  await mkdir(profilePaths.stateDir, { recursive: true });
  if (existsSync(profilePaths.lockFile)) {
    const raw = await readFile(profilePaths.lockFile, "utf8").catch(() => "");
    const pid = Number(raw.trim());
    if (pid && isAlive(pid)) return { acquired: false, pid };
    await unlink(profilePaths.lockFile).catch(() => {});
  }
  await writeFile(profilePaths.lockFile, String(process.pid), "utf8");
  return { acquired: true, pid: process.pid };
}

export async function releaseLock(profilePaths: ProfilePaths): Promise<void> {
  const raw = await readFile(profilePaths.lockFile, "utf8").catch(() => "");
  if (Number(raw.trim()) === process.pid) {
    await unlink(profilePaths.lockFile).catch(() => {});
  }
}

export async function readPid(profilePaths: ProfilePaths): Promise<number | null> {
  const raw = await readFile(profilePaths.pidFile, "utf8").catch(() => "");
  const pid = Number(raw.trim());
  return pid && isAlive(pid) ? pid : null;
}

export async function writePid(profilePaths: ProfilePaths, pid: number): Promise<void> {
  await mkdir(profilePaths.stateDir, { recursive: true });
  await writeFile(profilePaths.pidFile, String(pid), "utf8");
}

export async function clearPid(profilePaths: ProfilePaths): Promise<void> {
  await unlink(profilePaths.pidFile).catch(() => {});
}

export async function setPaused(profilePaths: ProfilePaths, paused: boolean): Promise<void> {
  if (paused) {
    await mkdir(profilePaths.stateDir, { recursive: true });
    await writeFile(profilePaths.pauseFile, new Date().toISOString(), "utf8");
  } else {
    await unlink(profilePaths.pauseFile).catch(() => {});
  }
}

export async function isPaused(profilePaths: ProfilePaths): Promise<boolean> {
  return existsSync(profilePaths.pauseFile);
}

export async function setStopped(profilePaths: ProfilePaths, stopped: boolean): Promise<void> {
  if (stopped) {
    await mkdir(profilePaths.stateDir, { recursive: true });
    await writeFile(profilePaths.stopFile, new Date().toISOString(), "utf8");
  } else {
    await unlink(profilePaths.stopFile).catch(() => {});
  }
}

export async function isStopped(profilePaths: ProfilePaths): Promise<boolean> {
  return existsSync(profilePaths.stopFile);
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
