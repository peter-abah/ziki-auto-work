import test from "node:test";
import assert from "node:assert/strict";
import { formatDrift } from "./drift.js";
test("formatDrift marks drifted findings", () => {
    const text = formatDrift({
        ok: false,
        findings: [
            { name: "project identity", ok: true, detail: "desktop (c1) still exists" },
            { name: "platform filter", ok: false, detail: 'filter "web2" resolves nowhere' }
        ]
    });
    assert.match(text, /^ok project identity/m);
    assert.match(text, /^DRIFT platform filter/m);
});
//# sourceMappingURL=drift.test.js.map