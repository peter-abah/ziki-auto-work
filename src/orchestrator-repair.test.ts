import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diagnoseForCode, verifyEndpointOps } from "./orchestrator.js";
import { loadInitTemplates, fillProfileFromTemplates } from "./config-templates.js";
import { ZikiError } from "./ziki.js";
import type { ProfileConfig } from "./types.js";

const templates = await loadInitTemplates();

function filledProfile(): ProfileConfig {
  const base = {
    ziki: { baseUrl: "https://ziki.dev", projectId: "c17fc4", projectSlug: "desktop", platform: "desktop", orgSlug: "zedu" },
    repo: { url: "", upstream: "", base: "main", githubRepo: "o/r", forkOwner: "f", defaultBranch: "main" },
    agents: { workers: [], managers: [] },
    executor: { provider: "opencode" },
    toolchain: {},
    checks: [],
    platformMatch: {},
    prompts: { dir: "prompts/generic" },
    pr: { templateFile: "prompts/generic/pr.md" },
    discovery: { enabled: false },
    workflow: { maxFiles: 5, maxLines: 400, branchPrefix: "fix", commitTypes: ["fix"], requireTests: true },
    limits: { maxActiveClaims: "auto" as const, maxAttemptsPerTask: null, maxNetworkRetries: 5, networkRetryMinutes: 1, maxCyclesBeforeDiscovery: 6, maxOpenEscalations: null },
    pollSeconds: 120,
    memoryRefreshMinutes: 30,
    hitl: { enabled: true, defaultType: "question" as const }
  } as unknown as ProfileConfig;
  return fillProfileFromTemplates(base, templates).profile;
}

function fakeCtx(client: unknown, profile: ProfileConfig): never {
  const dir = mkdtempSync(path.join(tmpdir(), "aw-repair-"));
  return {
    profile,
    primary: { name: "agent", key: "k", client },
    profilePaths: { stateDir: dir, historyFile: path.join(dir, "history.jsonl") },
    state: { escalations: {}, tasks: {}, noteDedupe: {}, recentFeedKeys: {}, counters: {}, memory: {}, feedEtags: {}, apiContracts: {}, activePids: [], health: { state: "healthy", blockers: {}, lastCheckAt: null }, run: {}, lastCycle: null, lastRun: null },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  } as never;
}

function blocker(message: string, details?: Record<string, unknown>): never {
  return {
    id: "feed:unexpected_response_shape",
    component: "feed",
    code: "unexpected_response_shape",
    severity: "warning",
    message,
    details,
    since: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    attempts: 1,
    nextRetryAt: null,
    notifiedAt: null
  } as never;
}

test("feed-shape failure with matching identity reaches the agent (no early wait)", async () => {
  const profile = filledProfile();
  const client = {
    listProjects: async () => ({ items: [{ id: "c17fc4", slug: "desktop", name: "Desktop" }] }),
    readProject: async () => ({ workUrl: "https://ziki.dev/zedu/desktop/work" })
  };
  const ctx = fakeCtx(client, profile);
  const result = await diagnoseForCode(
    ctx,
    "feed:unexpected_response_shape",
    blocker("GET /zedu/work failed: unexpected response shape", { expected: "feed", preview: "<!DOCTYPE html>" })
  );
  // Regression: this used to return done:"wait" (agent never ran). Now the
  // deterministic part only contributes evidence; the agent investigates.
  assert.equal(result.done, null);
  assert.match(result.summary, /Agent investigation required/);
  assert.ok(result.evidence.some((line) => line.includes("<!DOCTYPE html>")));
  rmSync((ctx as unknown as { profilePaths: { stateDir: string } }).profilePaths.stateDir, { recursive: true, force: true });
});

test("verifyEndpointOps drops proven-missing routes and keeps the rest", async () => {
  const profile = filledProfile();
  const client = {
    request: async (method: string, pathname: string) => {
      if (pathname === "/api/v1/nope") {
        throw new ZikiError("GET /api/v1/nope failed: No such API route.", {
          status: 404,
          body: { error: "not_found", message: "No such API route. See /llms.txt." },
          method,
          path: pathname
        });
      }
      if (pathname === "/api/v1/issues") return { items: [] };
      throw new ZikiError(`GET ${pathname} failed`, { status: 500, body: {}, method, path: pathname });
    }
  };
  const ctx = fakeCtx(client, profile);
  const ops = [
    { path: "ziki.endpoints.issues.nope", value: "/api/v1/nope" },
    { path: "ziki.endpoints.issues.list", value: "/api/v1/issues" },
    { path: "ziki.endpoints.issues.get", value: "/api/v1/issues/{issue}" },
    { path: "queue.priorities.brand_new_kind", value: 40 }
  ];
  const { ops: kept, notes } = await verifyEndpointOps(ctx, ops);
  assert.deepEqual(kept.map((op) => op.path).sort(), [
    "queue.priorities.brand_new_kind",
    "ziki.endpoints.issues.get",
    "ziki.endpoints.issues.list"
  ]);
  assert.ok(notes.some((note) => note.includes("dropped")), notes.join(" | "));
  assert.ok(notes.some((note) => note.includes("unverifiable")), notes.join(" | "));
  rmSync((ctx as unknown as { profilePaths: { stateDir: string } }).profilePaths.stateDir, { recursive: true, force: true });
});

test("config-doctor prompt authorizes read-only public probing, never writes", async () => {
  const { loadPrompt } = await import("./agent.js");
  const { loadInitTemplates: load } = await import("./config-templates.js");
  void load;
  const profile = filledProfile();
  const text = await loadPrompt({ ...profile, prompts: { dir: "prompts/generic" } }, "configDoctor");
  assert.match(text, /unauthenticated public URLs/);
  assert.match(text, /AW_RESULT_JSON/);
  assert.match(text, /never invent IDs, URLs, or slugs/);
});
