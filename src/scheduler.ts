export type TaskKind = "delivery" | "followup" | "review" | "aux" | "discovery" | "owner";

import { sleep } from "./log.js";

export interface TaskPoolLimits {
  delivery: number;
  followup: number;
  review: number;
  aux: number;
  discovery: number;
  owner: number;
  agents: number;
}

interface InFlight {
  key: string;
  kind: TaskKind;
  label?: string;
  agent?: string;
  startedAt: number;
  promise: Promise<void>;
}

export interface InFlightTask {
  key: string;
  kind: TaskKind;
  label?: string;
  agent?: string;
  startedAt: string;
  ageMs: number;
}

export class TaskPool {
  private readonly tasks = new Map<string, InFlight>();
  onChange: (() => void) | null = null;

  constructor(public limits: TaskPoolLimits) {}

  private changed(): void {
    try {
      this.onChange?.();
    } catch {
      // status reporting must never break the pool
    }
  }

  has(key: string): boolean {
    return this.tasks.has(key);
  }

  count(kind: TaskKind): number {
    return [...this.tasks.values()].filter((task) => task.kind === kind).length;
  }

  total(): number {
    return this.tasks.size;
  }

  canStart(kind: TaskKind): boolean {
    if (this.tasks.size >= this.limits.agents) return false;
    return this.count(kind) < (this.limits[kind] ?? 1);
  }

  reserve(key: string, kind: TaskKind, run: () => Promise<void>, label?: string, agent?: string): boolean {
    if (this.tasks.has(key) || !this.canStart(kind)) return false;
    const promise = Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        this.tasks.delete(key);
        this.changed();
      });
    this.tasks.set(key, { key, kind, label, agent, startedAt: Date.now(), promise });
    this.changed();
    return true;
  }

  list(): InFlightTask[] {
    const now = Date.now();
    return [...this.tasks.values()].map((task) => ({
      key: task.key,
      kind: task.kind,
      label: task.label,
      agent: task.agent,
      startedAt: new Date(task.startedAt).toISOString(),
      ageMs: now - task.startedAt
    }));
  }

  async waitForAny(): Promise<void> {
    if (!this.tasks.size) return;
    await Promise.race([...this.tasks.values()].map((task) => task.promise));
  }

  /**
   * Inter-cycle wait: sleep the full interval, but wake early when a pooled
   * agent finishes. A bare `Promise.race([pool.waitForAny(), sleep(ms)])`
   * resolves instantly on an empty pool (waitForAny is pre-resolved), which
   * hot-spins the loop whenever nothing is in flight — so the pool side only
   * joins the race when it is non-empty.
   */
  async waitForPoolOrTimeout(ms: number, signal?: AbortSignal): Promise<void> {
    const waitMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (this.tasks.size > 0) {
      await Promise.race([this.waitForAny(), sleep(waitMs, signal)]);
    } else {
      await sleep(waitMs, signal);
    }
  }

  async drain(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.tasks.size && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      await Promise.race([
        this.waitForAny(),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 1000)))
      ]);
    }
  }
}
