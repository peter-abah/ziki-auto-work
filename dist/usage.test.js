import test from "node:test";
import assert from "node:assert/strict";
import { addUsage, formatTokens, parseUsage, usagePercent } from "./usage.js";
test("parses Claude-style JSON usage and cost", () => {
    const usage = parseUsage(JSON.stringify({ type: "result", usage: { input_tokens: 100, output_tokens: 40 }, total_cost_usd: 0.02 }));
    assert.deepEqual(usage, { input: 100, output: 40, total: 140, costUsd: 0.02 });
});
test("parses JSONL usage events and takes the last one", () => {
    const text = [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 7 } })
    ].join("\n");
    const usage = parseUsage(text);
    assert.equal(usage?.input, 20);
    assert.equal(usage?.output, 7);
    assert.equal(usage?.total, 27);
});
test("supports custom regex extraction", () => {
    const usage = parseUsage("input 12 tokens\noutput 8 tokens", {
        regex: { input: "input\\s+(\\d+)\\s+tokens", output: "output\\s+(\\d+)\\s+tokens" }
    });
    assert.deepEqual(usage, { input: 12, output: 8, total: 20 });
});
test("estimates only when enabled", () => {
    assert.equal(parseUsage("12345678"), null);
    const estimated = parseUsage("12345678", { estimate: true });
    assert.equal(estimated?.estimated, true);
    assert.equal(estimated?.total, 2);
});
test("ignores source-code JSON that only has input/output fields", () => {
    assert.equal(parseUsage(JSON.stringify({ input: 429, output: 12 })), null);
});
test("adds usage and formats percentages", () => {
    const total = addUsage({ input: 10, output: 5, total: 15 }, { input: 20, output: 7, total: 27 });
    assert.equal(total.total, 42);
    assert.equal(formatTokens(1_500), "1.5k");
    assert.equal(usagePercent(80, 100), 80);
    assert.equal(usagePercent(120, 100), 100);
});
test("parses opencode step tokens with generic keys", () => {
    const text = JSON.stringify({
        type: "step_finish",
        part: { tokens: { total: 55577, input: 18086, output: 245 }, cost: 0.0019 }
    });
    const usage = parseUsage(text);
    assert.equal(usage?.input, 18086);
    assert.equal(usage?.output, 245);
    assert.equal(usage?.total, 55577);
});
//# sourceMappingURL=usage.test.js.map