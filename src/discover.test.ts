import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectedStackAt,
  gitProtocol,
  inferPlatform,
  parseRepoRef,
  pickCloneUrl,
  rankCandidates,
  repoName,
  resolveDiscoverPolicy,
  stackPlatform
} from "./discover.js";
import { loadInitTemplates } from "./config-templates.js";

const templates = await loadInitTemplates();
const policy = templates.discover as Parameters<typeof resolveDiscoverPolicy>[0];
const resolved = resolveDiscoverPolicy(policy);

test("parseRepoRef accepts owner/name, HTTPS and SSH", () => {
  assert.deepEqual(parseRepoRef("owner/name"), { owner: "owner", name: "name" });
  assert.deepEqual(parseRepoRef("https://github.com/owner/name.git"), { owner: "owner", name: "name" });
  assert.deepEqual(parseRepoRef("git@github.com:owner/name.git"), { owner: "owner", name: "name" });
  assert.equal(parseRepoRef("not a repo"), null);
});

test("template discover policy resolves", () => {
  assert.ok(resolved.scores.exact! > 0);
  assert.ok(resolved.timeouts.searchMs > 0);
  assert.ok(Object.keys(resolved.platformSuffixes).length >= 3);
});

test("inferPlatform reads common repo suffixes from policy", () => {
  assert.equal(inferPlatform("zedu-desktop", policy), "desktop");
  assert.equal(inferPlatform("zedu-mobile", policy), "mobile");
  assert.equal(inferPlatform("zedu-fe", policy), "web");
  assert.equal(inferPlatform("random", policy), null);
});

test("inferPlatform patterns are policy, not code", () => {
  const custom = { ...policy, platformPatterns: { ios: ["-ios$"] } };
  assert.equal(inferPlatform("app-ios", custom), "ios");
  assert.equal(inferPlatform("app-ios", policy), "mobile");
});

test("rankCandidates prefers the exact slug-platform repo", () => {
  const base = {
    url: "", sshUrl: undefined, description: undefined, isFork: false, isArchived: false, stars: 0
  };
  const ranked = rankCandidates(
    [
      { ...base, fullName: "zeduchat/zedu-fe" },
      { ...base, fullName: "zeduchat/zedu-desktop" },
      { ...base, fullName: "someone/zedu" }
    ],
    "zedu",
    "desktop",
    policy
  );
  assert.equal(ranked[0]!.fullName, "zeduchat/zedu-desktop");
  assert.equal(repoName(ranked[0]!.fullName), "zedu-desktop");
});

test("rankCandidates drops archived repos", () => {
  const ranked = rankCandidates(
    [
      { fullName: "owner/zedu-desktop", url: "", isFork: false, isArchived: true, stars: 100 },
      { fullName: "owner/zedu", url: "", isFork: false, isArchived: false, stars: 1 }
    ],
    "zedu",
    "desktop",
    policy
  );
  assert.deepEqual(ranked.map((candidate) => candidate.fullName), ["owner/zedu"]);
});

test("pickCloneUrl prefers SSH only when requested", () => {
  const info = { fullName: "o/n", cloneUrl: "https://github.com/o/n.git", sshUrl: "git@github.com:o/n.git", defaultBranch: "main", isFork: false, archived: false };
  assert.equal(pickCloneUrl(info, "ssh"), "git@github.com:o/n.git");
  assert.equal(pickCloneUrl(info, "https"), "https://github.com/o/n.git");
});

test("detectedStackAt detects common project files from policy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-stack-"));
  try {
    await writeFile(path.join(dir, "pubspec.yaml"), "");
    assert.equal(detectedStackAt(dir, resolved.stackMap), "flutter");
    assert.equal(stackPlatform("flutter", policy), "desktop");
    assert.equal(stackPlatform("node", policy), "web");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discover policy is required", () => {
  assert.throws(() => rankCandidates([], "x", null, null), /discover policy is required/);
  assert.throws(() => detectedStackAt("/tmp", {}), /discover\.stackMap is required/);
});

test("gitProtocol reads the github.com host setting before the global value", async () => {
  const calls: string[][] = [];
  const runner = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args.includes("-h")) return { ok: true, code: 0, stdout: "ssh\n", stderr: "", command: "" };
    return { ok: true, code: 0, stdout: "https\n", stderr: "", command: "" };
  };
  assert.equal(await gitProtocol("gh", runner as any, 1000), "ssh");
  assert.ok(calls[0]!.includes("github.com"));
});

test("gitProtocol falls back to the global value", async () => {
  const runner = async (_cmd: string, args: string[]) => {
    if (args.includes("-h")) return { ok: false, code: 1, stdout: "", stderr: "no host", command: "" };
    return { ok: true, code: 0, stdout: "ssh\n", stderr: "", command: "" };
  };
  assert.equal(await gitProtocol("gh", runner as any, 1000), "ssh");
});
