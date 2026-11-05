import type { RunLimitConfig, State } from "./types.js";

export type LimitReason = "max-cycles" | "max-deliveries" | "until" | "max-runtime";

export function cyclesThisRun(state: State): number {
  const started = Number(state.run?.startedCycles);
  if (Number.isFinite(started) && started >= 0) {
    return Math.max(0, state.cycles - started);
  }
  return Math.max(0, Number(state.cycles) || 0);
}

export function remainingCycles(state: State, maxCycles: number | null): number | null {
  if (maxCycles === null) return null;
  return Math.max(0, maxCycles - cyclesThisRun(state));
}

export function limitReached(
  state: State,
  limits: RunLimitConfig,
  now = Date.now()
): LimitReason | null {
  if (limits.maxCycles !== null && cyclesThisRun(state) >= limits.maxCycles) return "max-cycles";
  if (limits.maxDeliveriesTotal !== null && state.run.deliveries >= limits.maxDeliveriesTotal) return "max-deliveries";
  if (limits.stopAt) {
    const at = new Date(limits.stopAt).getTime();
    if (Number.isFinite(at) && now >= at) return "until";
  }
  if (limits.maxRuntimeMinutes !== null) {
    const started = state.run.startedAt ? new Date(state.run.startedAt).getTime() : now;
    if (now - started >= limits.maxRuntimeMinutes * 60 * 1000) return "max-runtime";
  }
  return null;
}
