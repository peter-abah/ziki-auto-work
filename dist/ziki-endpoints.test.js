import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENDPOINTS, endpointVars, parseWorkUrl, renderEndpoint, validateEndpointVars, validateEndpoints } from "./ziki-endpoints.js";
test("interpolates required and optional vars, collapses slashes", () => {
    assert.equal(renderEndpoint("/api/v1/{project}/work", { project: "desktop" }), "/api/v1/desktop/work");
    assert.equal(renderEndpoint("/{org?}/{project}/work", { project: "d" }), "/d/work");
    assert.equal(renderEndpoint("/{org?}/{project}/work", { org: "z", project: "d" }), "/z/d/work");
    assert.equal(renderEndpoint("/api/v1/issues/{issue}/comments", { issue: 42 }), "/api/v1/issues/42/comments");
});
test("rejects missing required vars, unknown shapes and absolute URLs", () => {
    assert.throws(() => renderEndpoint("/api/v1/{project}/work", {}), /\$project/);
    assert.throws(() => renderEndpoint("api/v1/issues", {}), /relative/);
    assert.throws(() => renderEndpoint("https://evil.test/x", {}), /must not contain|relative/);
    assert.throws(() => renderEndpoint("/api/v1/{__proto__}/x", { __proto__: "y" }), /forbidden/);
});
test("endpointVars merges explicit vars with identity fields", () => {
    const vars = endpointVars({
        vars: { team: "t1" },
        projectId: "p1",
        projectSlug: "desktop",
        orgSlug: "zedu",
        platform: undefined
    });
    assert.deepEqual(vars, { team: "t1", projectId: "p1", project: "desktop", org: "zedu" });
});
test("validateEndpoints accepts the shipped registry", () => {
    assert.deepEqual(validateEndpoints(DEFAULT_ENDPOINTS, ["projectId", "projectSlug", "orgSlug", "platform", "project", "org"]), []);
});
test("validateEndpoints rejects absolute URLs, unknown vars and unbalanced braces", () => {
    assert.ok(validateEndpoints({ a: { b: "https://evil.test/x" } }, []).length > 0);
    assert.ok(validateEndpoints({ a: { b: "/x/{nope}/y" } }, []).length > 0);
    assert.ok(validateEndpoints({ a: { b: "/x/{unclosed" } }, []).length > 0);
    assert.ok(validateEndpoints({ a: { b: "/x/{__proto__}" } }, []).length > 0);
    assert.deepEqual(validateEndpoints({ a: { b: "/x/{project}" } }, []), []);
});
test("validateEndpointVars enforces shape", () => {
    assert.deepEqual(validateEndpointVars({ team: "t1" }), []);
    assert.ok(validateEndpointVars({ "a.b": "x" }).length > 0);
    assert.ok(validateEndpointVars({ ok: "" }).length > 0);
    assert.ok(validateEndpointVars({ ok: "has space" }).length > 0);
    assert.ok(validateEndpointVars("nope").length > 0);
});
test("parseWorkUrl extracts org and project", () => {
    assert.deepEqual(parseWorkUrl("https://ziki.dev/zedu/desktop/work"), { org: "zedu", project: "desktop" });
    assert.equal(parseWorkUrl("https://ziki.dev/zedu/work"), null);
    assert.equal(parseWorkUrl(null), null);
    assert.equal(parseWorkUrl("not a url"), null);
});
//# sourceMappingURL=ziki-endpoints.test.js.map