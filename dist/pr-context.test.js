import test from "node:test";
import assert from "node:assert/strict";
import { formatPrContext } from "./pr-context.js";
const status = {
    url: "https://github.com/owner/repo/pull/7",
    state: "OPEN",
    merged: false,
    mergedInto: "main",
    mergeCommitSha: null,
    headSha: "abc123",
    headRefName: "fix/7-thing",
    baseRefName: "main",
    checks: "failing",
    mergeable: false,
    reviewDecision: "CHANGES_REQUESTED",
    comments: [],
    reviews: [],
    checkRuns: [
        { name: "build", status: "COMPLETED", conclusion: "FAILURE", url: "https://github.com/owner/repo/actions/runs/1" }
    ]
};
test("formatPrContext includes state, checks and comments", () => {
    const text = formatPrContext(status, [
        {
            id: "c1",
            author: "reviewer",
            body: "Please fix the null check",
            path: "lib/main.dart",
            line: 42,
            createdAt: "2026-01-01T00:00:00Z",
            kind: "review"
        }
    ], [{ name: "build", log: "error: null check failed" }]);
    assert.match(text, /Checks: failing/);
    assert.match(text, /build: FAILURE/);
    assert.match(text, /lib\/main.dart:42/);
    assert.match(text, /null check failed/);
});
//# sourceMappingURL=pr-context.test.js.map