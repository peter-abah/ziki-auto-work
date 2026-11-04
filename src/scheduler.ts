export type TaskKind = "delivery" | "review" | "aux" | "discovery" | "owner";

export interface TaskPoolLimits {
  delivery: number;
  review: number;
  aux: number;
  discovery: number;
  owner: number;
  agents: number;
}

interface InFlight {
  key: string;
  kind: TaskKind;
  startedAt: number;
  promise: Promise<void>;
}

export class TaskPool {
  private readonly tasks = new Map<string, InFlight>();

  constructor(public limits: TaskPoolLimits) {}

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

  reserve(key: string, kind: TaskKind, run: () => Promise<void>): boolean {
    if (this.tasks.has(key) || !this.canStart(kind)) return false;
    const promise = Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        this.tasks.delete(key);
      });
    this.tasks.set(key, { key, kind, startedAt: Date.now(), promise });
    return true;
  }

  list(): Array<{ key: string; kind: TaskKind; startedAt: string; ageMs: number }> {
    const now = Date.now();
    return [...this.tasks.values()].map((task) => ({
      key: task.key,
      kind: task.kind,
      startedAt: new Date(task.startedAt).toISOString(),
      ageMs: now - task.startedAt
    }));
  }

  async waitForAny(): Promise<void> {
    if (!this.tasks.size) return;
    await Promise.race([...this.tasks.values()].map((task) => task.promise));
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
