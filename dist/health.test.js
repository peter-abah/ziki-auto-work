import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, clearBlocker, emptyHealth, healthLabel, nextRetryDelay, reportBlocker, summarizeHealth } from "./health.js";
import { ZikiError } from "./ziki.js";
function zikiError(status, body) {
    return new ZikiError("request failed", { status, body, method: "GET", path: "/zedu/work" });
}
test("classifies a profile-incomplete Ziki response as a blocked agent issue", () => {
    const report = classifyError(zikiError(403, {
        error: "profile_incomplete",
        message: "Set up the profile",
        missing: ["tagline", "about", "skills"],
        setup_url: "https://ziki.dev/agent/stilgar/edit"
    }), "feed");
    assert.equal(report.component, "agent");
    assert.equal(report.code, "profile_incomplete");
    assert.equal(report.severity, "blocked");
    assert.deepEqual(report.details.missing, ["tagline", "about", "skills"]);
});
test("classifies auth, rate limits and network errors", () => {
    assert.equal(classifyError(zikiError(401, {}), "feed").code, "auth");
    assert.equal(classifyError(zikiError(429, {}), "feed").code, "rate_limit");
    assert.equal(classifyError(zikiError(503, {}), "feed").code, "network");
    assert.equal(classifyError(Object.assign(new Error("reset"), { code: "ECONNRESET" }), "github").code, "network");
});
test("normalizes restructured-taxonomy 422s to unknown_filter warnings", () => {
    const report = classifyError(zikiError(422, { error: 'Unknown platform "general". Use a slug from GET /api/v1/platforms, or "none".' }), "platform");
    assert.equal(report.code, "unknown_filter");
    assert.equal(report.severity, "warning");
    const other = classifyError(zikiError(422, { error: "Send a valid JSON body." }), "inbox");
    assert.equal(other.code, "Send a valid JSON body.");
    assert.equal(other.severity, "warning");
});
test("reports, summarizes and clears blockers", () => {
    const health = emptyHealth();
    const first = reportBlocker(health, {
        component: "feed",
        code: "network",
        severity: "degraded",
        message: "feed unreachable",
        agents: ["Stilgar"],
        retryMs: 60_000
    });
    assert.equal(first.created, true);
    assert.equal(health.state, "degraded");
    assert.match(healthLabel(health), /degraded: network \(Stilgar\)/);
    const second = reportBlocker(health, {
        component: "agent",
        code: "profile_incomplete",
        severity: "blocked",
        message: "profiles incomplete",
        agents: ["Muadib"],
        retryMs: 300_000
    });
    assert.equal(second.created, true);
    assert.equal(summarizeHealth(health).state, "blocked");
    assert.ok(nextRetryDelay(health) !== null);
    clearBlocker(health, "agent", "profile_incomplete");
    assert.equal(health.state, "degraded");
    clearBlocker(health, "feed");
    assert.equal(health.state, "healthy");
});
test("warnings do not count as a retry blocker", () => {
    const health = emptyHealth();
    reportBlocker(health, {
        component: "memory",
        code: "refresh",
        severity: "warning",
        message: "cache unavailable",
        retryMs: 60_000
    });
    assert.equal(nextRetryDelay(health), null);
});
//# sourceMappingURL=health.test.js.map