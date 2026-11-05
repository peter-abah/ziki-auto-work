import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "./state.js";
import { cyclesThisRun, limitReached, remainingCycles } from "./run-limits.js";
function limits(overrides = {}) {
    return { maxRuntimeMinutes: null, maxCycles: null, stopAt: null, maxDeliveriesTotal: null, ...overrides };
}
test("maxCycles is measured within the current run", () => {
    const state = emptyState();
    state.cycles = 421312;
    state.run.startedCycles = 421312;
    assert.equal(cyclesThisRun(state), 0);
    delete state.run.startedCycles;
    assert.equal(cyclesThisRun(state), 421312);
    state.run.startedCycles = 421312;
    assert.equal(limitReached(state, limits({ maxCycles: 3 }), Date.now()), null);
    state.cycles = 421315;
    assert.equal(limitReached(state, limits({ maxCycles: 3 }), Date.now()), "max-cycles");
    assert.equal(remainingCycles(state, 3), 0);
});
test("run limits still cover deliveries and wall-clock time", () => {
    const state = emptyState();
    state.run.startedAt = new Date(Date.now() - 60_000).toISOString();
    assert.equal(limitReached(state, limits({ maxDeliveriesTotal: 1 }), Date.now()), null);
    state.run.deliveries = 1;
    assert.equal(limitReached(state, limits({ maxDeliveriesTotal: 1 }), Date.now()), "max-deliveries");
    assert.equal(limitReached(state, limits({ maxRuntimeMinutes: 0 }), Date.now()), "max-runtime");
});
//# sourceMappingURL=run-limits.test.js.map