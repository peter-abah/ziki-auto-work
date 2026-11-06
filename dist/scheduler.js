import { sleep } from "./log.js";
export class TaskPool {
    limits;
    tasks = new Map();
    onChange = null;
    constructor(limits) {
        this.limits = limits;
    }
    changed() {
        try {
            this.onChange?.();
        }
        catch {
            // status reporting must never break the pool
        }
    }
    has(key) {
        return this.tasks.has(key);
    }
    count(kind) {
        return [...this.tasks.values()].filter((task) => task.kind === kind).length;
    }
    total() {
        return this.tasks.size;
    }
    canStart(kind) {
        if (this.tasks.size >= this.limits.agents)
            return false;
        return this.count(kind) < (this.limits[kind] ?? 1);
    }
    reserve(key, kind, run, label, agent) {
        if (this.tasks.has(key) || !this.canStart(kind))
            return false;
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
    list() {
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
    async waitForAny() {
        if (!this.tasks.size)
            return;
        await Promise.race([...this.tasks.values()].map((task) => task.promise));
    }
    /**
     * Inter-cycle wait: sleep the full interval, but wake early when a pooled
     * agent finishes. A bare `Promise.race([pool.waitForAny(), sleep(ms)])`
     * resolves instantly on an empty pool (waitForAny is pre-resolved), which
     * hot-spins the loop whenever nothing is in flight — so the pool side only
     * joins the race when it is non-empty.
     */
    async waitForPoolOrTimeout(ms, signal) {
        const waitMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
        if (this.tasks.size > 0) {
            await Promise.race([this.waitForAny(), sleep(waitMs, signal)]);
        }
        else {
            await sleep(waitMs, signal);
        }
    }
    async drain(timeoutMs, sliceMs) {
        if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new Error("drain requires an explicit timeoutMs from loop policy (no default)");
        }
        if (typeof sliceMs !== "number" || !Number.isFinite(sliceMs) || sliceMs <= 0) {
            throw new Error("drain requires an explicit sliceMs from loop policy (no default)");
        }
        const deadline = Date.now() + timeoutMs;
        while (this.tasks.size && Date.now() < deadline) {
            const remaining = Math.max(1, deadline - Date.now());
            await Promise.race([
                this.waitForAny(),
                new Promise((resolve) => setTimeout(resolve, Math.min(remaining, sliceMs)))
            ]);
        }
    }
}
//# sourceMappingURL=scheduler.js.map