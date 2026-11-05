import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderLimit, providerLimitForResult } from "./provider-errors.js";
test("accepts only explicit provider limits", () => {
    assert.equal(normalizeProviderLimit("quota"), "quota");
    assert.equal(normalizeProviderLimit("rate-limit"), "rate-limit");
    assert.equal(normalizeProviderLimit("context"), "context");
    assert.equal(normalizeProviderLimit("billing"), null);
    assert.equal(normalizeProviderLimit(429), null);
});
test("a successful result never carries a provider limit", () => {
    assert.equal(providerLimitForResult({ ok: true, providerLimit: "quota" }, false), null);
});
test("a failed result keeps only its explicit provider limit", () => {
    assert.equal(providerLimitForResult({ ok: false, providerLimit: "quota" }, true), "quota");
    assert.equal(providerLimitForResult({ ok: false }, true), null);
    assert.equal(providerLimitForResult(null, true), null);
});
//# sourceMappingURL=provider-errors.test.js.map