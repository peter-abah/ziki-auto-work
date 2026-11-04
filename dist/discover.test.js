import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectedStackAt, gitProtocol, inferPlatform, parseRepoRef, pickCloneUrl, rankCandidates, repoName } from "./discover.js";
test("parseRepoRef accepts owner/name, HTTPS and SSH", () => {
    assert.deepEqual(parseRepoRef("owner/name"), { owner: "owner", name: "name" });
    assert.deepEqual(parseRepoRef("https://github.com/owner/name.git"), { owner: "owner", name: "name" });
    assert.deepEqual(parseRepoRef("git@github.com:owner/name.git"), { owner: "owner", name: "name" });
    assert.equal(parseRepoRef("not a repo"), null);
});
test("inferPlatform reads common repo suffixes", () => {
    assert.equal(inferPlatform("zedu-desktop"), "desktop");
    assert.equal(inferPlatform("zedu-mobile"), "mobile");
    assert.equal(inferPlatform("zedu-fe"), "web");
    assert.equal(inferPlatform("random"), null);
});
test("rankCandidates prefers the exact slug-platform repo", () => {
    const base = {
        url: "", sshUrl: undefined, description: undefined, isFork: false, isArchived: false, stars: 0
    };
    const ranked = rankCandidates([
        { ...base, fullName: "zeduchat/zedu-fe" },
        { ...base, fullName: "zeduchat/zedu-desktop" },
        { ...base, fullName: "someone/zedu" }
    ], "zedu", "desktop");
    assert.equal(ranked[0].fullName, "zeduchat/zedu-desktop");
    assert.equal(repoName(ranked[0].fullName), "zedu-desktop");
});
test("rankCandidates drops archived repos", () => {
    const ranked = rankCandidates([
        { fullName: "owner/zedu-desktop", url: "", isFork: false, isArchived: true, stars: 100 },
        { fullName: "owner/zedu", url: "", isFork: false, isArchived: false, stars: 1 }
    ], "zedu", "desktop");
    assert.deepEqual(ranked.map((candidate) => candidate.fullName), ["owner/zedu"]);
});
test("pickCloneUrl prefers SSH only when requested", () => {
    const info = { fullName: "o/n", cloneUrl: "https://github.com/o/n.git", sshUrl: "git@github.com:o/n.git", defaultBranch: "main", isFork: false, archived: false };
    assert.equal(pickCloneUrl(info, "ssh"), "git@github.com:o/n.git");
    assert.equal(pickCloneUrl(info, "https"), "https://github.com/o/n.git");
});
test("detectedStackAt detects common project files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "auto-work-stack-"));
    try {
        await writeFile(path.join(dir, "pubspec.yaml"), "");
        assert.equal(detectedStackAt(dir), "flutter");
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("gitProtocol reads the github.com host setting before the global value", async () => {
    const calls = [];
    const runner = async (_cmd, args) => {
        calls.push(args);
        if (args.includes("-h"))
            return { ok: true, code: 0, stdout: "ssh\n", stderr: "", command: "" };
        return { ok: true, code: 0, stdout: "https\n", stderr: "", command: "" };
    };
    assert.equal(await gitProtocol("gh", runner), "ssh");
    assert.ok(calls[0].includes("github.com"));
});
test("gitProtocol falls back to the global value", async () => {
    const runner = async (_cmd, args) => {
        if (args.includes("-h"))
            return { ok: false, code: 1, stdout: "", stderr: "no host", command: "" };
        return { ok: true, code: 0, stdout: "ssh\n", stderr: "", command: "" };
    };
    assert.equal(await gitProtocol("gh", runner), "ssh");
});
//# sourceMappingURL=discover.test.js.map