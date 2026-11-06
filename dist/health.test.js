import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, clearBlocker, emptyHealth, healthLabel, nextRetryDelay, reportBlocker, retryMsFor, summarizeHealth } from "./health.js";
import { ZikiError } from "./ziki.js";
import { loadInitTemplates } from "./config-templates.js";
const templates = await loadInitTemplates();
const profile = { health: templates.health };
function zikiError(status, body) {
    return new ZikiError("request failed", { status, body, method: "GET", path: "/zedu/work" });
}
test("classifies a profile-incomplete Ziki response as a blocked agent issue", () => {
    const report = classifyError(zikiError(403, {
        error: "profile_incomplete",
        message: "Set up the profile",
        missing: ["tagline", "about", "skills"],
        setup_url: "https://ziki.dev/agent/stilgar/edit"
    }), "feed", profile);
    assert.equal(report.component, "agent");
    assert.equal(report.code, "profile_incomplete");
    assert.equal(report.severity, "blocked");
    assert.deepEqual(report.details.missing, ["tagline", "about", "skills"]);
    assert.equal(report.retryMs, 300000);
});
test("classifies auth, rate limits and network errors", () => {
    assert.equal(classifyError(zikiError(401, {}), "feed", profile).code, "auth");
    assert.equal(classifyError(zikiError(429, {}), "feed", profile).code, "rate_limit");
    assert.equal(classifyError(zikiError(503, {}), "feed", profile).code, "network");
    assert.equal(classifyError(Object.assign(new Error("reset"), { code: "ECONNRESET" }), "github", profile).code, "network");
});
test("retry backoff comes from health.retryMs, not code", () => {
    assert.equal(classifyError(zikiError(401, {}), "feed", profile).retryMs, 300000);
    assert.equal(classifyError(zikiError(429, {}), "feed", profile).retryMs, 900000);
    assert.equal(classifyError(zikiError(503, {}), "feed", profile).retryMs, 60000);
    const custom = { health: { retryMs: { "*:rate_limit": 1000, "*": 2000 } } };
    assert.equal(classifyError(zikiError(429, {}), "feed", custom).retryMs, 1000);
    assert.equal(classifyError(zikiError(503, {}), "feed", custom).retryMs, 2000);
    assert.throws(() => retryMsFor(null, "feed:network"), /health\.retryMs must be an object/);
    assert.throws(() => retryMsFor({ health: { retryMs: {} } }, "feed:bogus"), /has no entry/);
});
test("config-shape failures become config blockers", () => {
    const missing = classifyError(new Error("profile.queue is required (run `auto-work migrate`)"), "feed", profile);
    assert.equal(missing.component, "config");
    assert.equal(missing.code, "missing_key");
    assert.equal(missing.severity, "blocked");
    assert.equal(missing.retryMs, 300000);
    const unknown = classifyError(new Error("unknown endpoint: issues.bid (not in ziki.endpoints)"), "feed", profile);
    assert.equal(unknown.component, "config");
    assert.equal(unknown.code, "unknown_endpoint");
});
test("normalizes restructured-taxonomy 422s to unknown_filter warnings", () => {
    const report = classifyError(zikiError(422, { error: 'Unknown platform "general". Use a slug from GET /api/v1/platforms, or "none".' }), "platform", profile);
    assert.equal(report.code, "unknown_filter");
    assert.equal(report.severity, "warning");
    const other = classifyError(zikiError(422, { error: "Send a valid JSON body." }), "inbox", profile);
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