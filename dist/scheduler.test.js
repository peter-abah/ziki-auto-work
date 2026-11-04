import test from "node:test";
import assert from "node:assert/strict";
import { TaskPool } from "./scheduler.js";
function gated() {
    let release = () => { };
    let released = false;
    const run = () => new Promise((resolve) => {
        release = resolve;
        if (released)
            resolve();
    });
    return {
        run,
        release: () => {
            released = true;
            release();
        }
    };
}
test("TaskPool enforces per-kind and total agent limits", async () => {
    const pool = new TaskPool({ delivery: 2, review: 1, aux: 2, discovery: 1, owner: 1, agents: 4 });
    const gates = [gated(), gated(), gated(), gated(), gated()];
    assert.equal(pool.reserve("d1", "delivery", gates[0].run), true);
    assert.equal(pool.reserve("d2", "delivery", gates[1].run), true);
    assert.equal(pool.reserve("d3", "delivery", gates[2].run), false);
    assert.equal(pool.reserve("r1", "review", gates[3].run), true);
    assert.equal(pool.count("delivery"), 2);
    assert.equal(pool.count("review"), 1);
    assert.equal(pool.total(), 3);
    assert.equal(pool.canStart("owner"), true);
    assert.equal(pool.reserve("o1", "owner", gates[4].run), true);
    assert.equal(pool.total(), 4);
    assert.equal(pool.canStart("aux"), false);
    [gates[0], gates[1], gates[3], gates[4]].forEach((gate) => gate.release());
    await pool.drain(1000);
    assert.equal(pool.total(), 0);
});
test("TaskPool rejects duplicate in-flight keys", () => {
    const pool = new TaskPool({ delivery: 2, review: 1, aux: 2, discovery: 1, owner: 1, agents: 4 });
    const gate = gated();
    assert.equal(pool.reserve("same", "delivery", gate.run), true);
    assert.equal(pool.reserve("same", "delivery", gate.run), false);
    assert.equal(pool.total(), 1);
    gate.release();
});
test("scheduler starts two deliveries and one review concurrently", async () => {
    const pool = new TaskPool({ delivery: 2, review: 1, aux: 2, discovery: 1, owner: 1, agents: 4 });
    const started = [];
    const gates = [];
    const task = (key) => () => new Promise((resolve) => {
        started.push(key);
        gates.push(resolve);
    });
    assert.equal(pool.reserve("issue-1", "delivery", task("d1")), true);
    assert.equal(pool.reserve("issue-2", "delivery", task("d2")), true);
    assert.equal(pool.reserve("review-1", "review", task("r1")), true);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(started.sort(), ["d1", "d2", "r1"]);
    assert.equal(pool.reserve("issue-3", "delivery", task("d3")), false);
    gates.forEach((release) => release());
    await pool.drain(1000);
});
test("TaskPool.list reports in-flight kind and age for status", async () => {
    const pool = new TaskPool({ delivery: 2, review: 1, aux: 2, discovery: 1, owner: 1, agents: 4 });
    const gate = gated();
    pool.reserve("issue-9", "delivery", gate.run);
    const list = pool.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].key, "issue-9");
    assert.equal(list[0].kind, "delivery");
    assert.ok(list[0].ageMs >= 0);
    gate.release();
    await pool.drain(1000);
});
//# sourceMappingURL=scheduler.test.js.map