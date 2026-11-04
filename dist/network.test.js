import test from "node:test";
import assert from "node:assert/strict";
import { isTransientNetworkError, isTransientNetworkText, retryNetwork } from "./network.js";
test("network classifier recognizes common git and HTTP failures", () => {
    assert.equal(isTransientNetworkText("fatal: unable to access: Could not resolve host: github.com"), true);
    assert.equal(isTransientNetworkText("RPC failed; curl 56 GnuTLS recv error"), true);
    assert.equal(isTransientNetworkText("remote end hung up unexpectedly"), true);
    assert.equal(isTransientNetworkText("HTTP 503 Service Unavailable"), true);
    assert.equal(isTransientNetworkText("fatal: Authentication failed"), false);
    assert.equal(isTransientNetworkText("error: pathspec 'nope' did not match"), false);
});
test("isTransientNetworkError reads status and error codes", () => {
    assert.equal(isTransientNetworkError({ status: 502 }), true);
    assert.equal(isTransientNetworkError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), true);
    assert.equal(isTransientNetworkError(new Error("bad credentials")), false);
});
test("retryNetwork retries transient failures only", async () => {
    let attempts = 0;
    const result = await retryNetwork(async () => {
        attempts += 1;
        if (attempts < 3)
            throw new Error("ECONNRESET");
        return "ok";
    }, { attempts: 3, baseMs: 1 });
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
    let permanent = 0;
    await assert.rejects(retryNetwork(async () => {
        permanent += 1;
        throw new Error("permission denied");
    }, { attempts: 3, baseMs: 1 }));
    assert.equal(permanent, 1);
});
//# sourceMappingURL=network.test.js.map