import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preparePrBody } from "./pr-body.js";
function profile(templateFile) {
    return {
        ziki: { baseUrl: "https://ziki.dev", projectId: "p", projectSlug: "demo", platform: "desktop" },
        repo: {
            url: "git@github.com:team/demo.git",
            upstream: "https://github.com/owner/demo.git",
            base: "main",
            githubRepo: "owner/demo",
            forkOwner: "team",
            defaultBranch: "main"
        },
        agents: { workers: ["K1"], managers: [] },
        executor: { provider: "opencode", model: null },
        toolchain: {},
        checks: [],
        platformMatch: { keywords: ["desktop"] },
        prompts: { dir: "prompts/generic" },
        pr: { templateFile, teamLead: "@lead" },
        discovery: { enabled: false },
        workflow: { maxFiles: 5, maxLines: 400, branchPrefix: "fix", commitTypes: ["fix"], requireTests: true },
        limits: {
            maxDeliveriesPerDay: 1,
            maxReviewsPerDay: 1,
            maxDiscoveriesPerDay: 1,
            maxAuxPerCycle: 1,
            maxActiveClaims: 1,
            maxAttemptsPerTask: 3,
            maxNetworkRetries: 5,
            networkRetryMinutes: 1,
            maxCyclesBeforeDiscovery: 6,
            maxOpenEscalations: 5
        },
        pollSeconds: 120,
        memoryRefreshMinutes: 30,
        hitl: { enabled: true, defaultType: "question" }
    };
}
const issue = {
    id: "i1",
    number: 42,
    title: "Fix the thing",
    summary: "It is broken",
    description: "Do it",
    status: "in_progress",
    substatus: "ready"
};
const fallbackInput = {
    issue,
    summary: "Fixed",
    description: "Changed it",
    testResults: "pass",
    checks: ["test: pass"]
};
test("agent PR body is used verbatim and gets a ticket link if missing", async () => {
    const result = await preparePrBody({
        profile: profile("prompts/generic/pr.md"),
        issue,
        result: { ok: true, prBody: "## What changed\n\nStuff" },
        fallback: fallbackInput
    });
    assert.equal(result.source, "agent");
    assert.match(result.body, /^Ziki: https:\/\/ziki\.dev\/demo\/42/);
    assert.match(result.body, /## What changed/);
});
test("agent PR body unwraps a markdown fence", async () => {
    const result = await preparePrBody({
        profile: profile("prompts/generic/pr.md"),
        issue,
        result: { ok: true, prBody: "```markdown\n## Ticket\n\n#42\n```" },
        fallback: fallbackInput
    });
    assert.equal(result.body, "## Ticket\n\n#42");
});
test("invalid agent body falls back to the configured template", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-pr-"));
    try {
        const template = path.join(dir, "pr.md");
        await writeFile(template, "## Ticket\n\n{{ticket}}\n\n## Test evidence\n\n{{testResults}}\n", "utf8");
        const result = await preparePrBody({
            profile: profile(template),
            issue,
            result: { ok: true, prBody: "## Ticket\n\n{{ticket}}" },
            fallback: fallbackInput
        });
        assert.equal(result.source, "fallback");
        assert.match(result.body, /\/42/);
        assert.match(result.body, /pass/);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=pr-body.test.js.map