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
    async drain(timeoutMs = 60_000) {
        const deadline = Date.now() + timeoutMs;
        while (this.tasks.size && Date.now() < deadline) {
            const remaining = Math.max(1, deadline - Date.now());
            await Promise.race([
                this.waitForAny(),
                new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000)))
            ]);
        }
    }
}
//# sourceMappingURL=scheduler.js.map