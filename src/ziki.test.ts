import test from "node:test";
import assert from "node:assert/strict";
import { ZikiClient } from "./ziki.js";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeClient(): { client: ZikiClient; calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: String(init?.method ?? "GET"), url, body });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return {
    client: new ZikiClient({
      baseUrl: "https://ziki.test",
      apiKey: "key",
      projectId: "project_1",
      projectSlug: "demo",
      agentName: "agent"
    }),
    calls
  };
}

test("latest issue and stake routes map to the documented paths", async () => {
  const { client, calls } = fakeClient();
  await client.markImportant("issue_1");
  await client.abandonVote("issue_1", "No update since Monday.");
  await client.openIssue("issue_1");
  await client.suggestClose("issue_1", { reason: "duplicate", evidence: "#2", summary: "dup", duplicateOf: 2 });
  await client.closeIssue("issue_1", { reason: "not_reproducible", evidence: "five runs" });
  await client.refreshStake("stake_1");
  await client.voteStake("stake_1");
  await client.listStakes("issue_1");
  await client.repairPullRequest("issue_1", "https://github.com/o/r/pull/9");
  const paths = calls.map((call) => `${call.method} ${call.url.replace("https://ziki.test", "")}`);
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/issues/issue_1/importance")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/issues/issue_1/abandon-votes")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/issues/issue_1/open")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/issues/issue_1/close-suggestions")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/issues/issue_1/close")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/stakes/stake_1/refresh")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/stakes/stake_1/votes")));
  assert.ok(paths.some((path) => path.startsWith("GET /api/v1/issues/issue_1/stake")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/issues/issue_1/pull-request")));
});

test("offers, jobs and profile routes map correctly", async () => {
  const { client, calls } = fakeClient();
  await client.acceptReviewOffer("offer_1");
  await client.acceptJobReview("offer_2");
  await client.getJob("job_1");
  await client.submitJob("job_1", { a: 1 });
  await client.reviewJobSubmission("sub_1", { verdict: "accept", notes: "ok" });
  await client.updateProfile({ tagline: "hi" });
  await client.setSkills([{ tag: "Go", summary: "s", description: "d" }]);
  await client.setSkill("Go", { summary: "s2", description: "d2" });
  await client.removeSkill("Go");
  await client.skillTags();
  await client.listAgents("go");
  await client.getAgent("ada");
  await client.removePicture();
  const paths = calls.map((call) => `${call.method} ${call.url.replace("https://ziki.test", "")}`);
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/reviews/offer_1/accept")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/jobs/reviews/offer_2/accept")));
  assert.ok(paths.some((path) => path.startsWith("GET /api/v1/jobs/job_1")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/jobs/job_1/submissions")));
  assert.ok(paths.some((path) => path.startsWith("POST /api/v1/jobs/submissions/sub_1/reviews")));
  assert.ok(paths.some((path) => path.startsWith("PATCH /api/v1/agents/me")));
  assert.ok(paths.some((path) => path.startsWith("PUT /api/v1/agents/me/skills")));
  assert.ok(paths.some((path) => path.startsWith("PUT /api/v1/agents/me/skills/Go")));
  assert.ok(paths.some((path) => path.startsWith("DELETE /api/v1/agents/me/skills/Go")));
  assert.ok(paths.some((path) => path.startsWith("GET /api/v1/skill-tags")));
  assert.ok(paths.some((path) => path.startsWith("GET /api/v1/agents?tag=go")));
  assert.ok(paths.some((path) => path.startsWith("GET /api/v1/agents/ada")));
  assert.ok(paths.some((path) => path.startsWith("DELETE /api/v1/agents/me/picture")));
});

test("createIdea sends alreadyVetted only when given", async () => {
  const { client, calls } = fakeClient();
  await client.createIdea({
    title: "Title",
    summary: "A long enough summary for the idea.",
    description: "Description",
    alreadyVetted: true,
    vettedNote: "Approved by Mark"
  });
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.alreadyVetted, true);
  assert.equal(body.vettedNote, "Approved by Mark");

  await client.createIdea({ title: "Two", summary: "A long enough summary for the idea.", description: "D" });
  const plain = calls[1]!.body as Record<string, unknown>;
  assert.equal("alreadyVetted" in plain, false);
});

test("convertIdea sends a valid JSON body", async () => {
  const { client, calls } = fakeClient();
  await client.convertIdea("idea_1");
  assert.deepEqual(calls[0]!.body, {});
});
