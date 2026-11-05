import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contextCandidates, loadDiscoveryContext } from "./discovery-context.js";
test("resolves relative context files from the repo first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "auto-work-discovery-"));
    const repo = path.join(root, "repo");
    const packageRoot = path.join(root, "package");
    try {
        await mkdir(path.join(repo, "docs"), { recursive: true });
        await writeFile(path.join(repo, "docs", "ARCH.md"), "repo architecture", "utf8");
        const context = await loadDiscoveryContext({
            contextFiles: ["docs/ARCH.md", "openapi.yaml"],
            repoDir: repo,
            packageRoot
        });
        assert.equal(context.missing.length, 1);
        assert.match(context.context, /repo architecture/);
        assert.match(context.context, /openapi\.yaml/);
        assert.match(context.context, /file not found/);
        assert.equal(context.parity, "(no parity map yet)");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("falls back to the package root and reports missing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "auto-work-discovery-"));
    const repo = path.join(root, "repo");
    const packageRoot = path.join(root, "package");
    try {
        await mkdir(repo, { recursive: true });
        await mkdir(path.join(packageRoot, "examples"), { recursive: true });
        await writeFile(path.join(packageRoot, "examples", "parity.md"), "# parity", "utf8");
        const context = await loadDiscoveryContext({
            parityFile: path.join(packageRoot, "examples", "parity.md"),
            repoDir: repo,
            packageRoot
        });
        assert.equal(context.parity, "# parity");
        assert.match(context.context, /# parity/);
        assert.deepEqual(context.missing, []);
        assert.deepEqual(contextCandidates("examples/parity.md", repo, packageRoot), [
            path.join(repo, "examples/parity.md"),
            path.join(packageRoot, "examples/parity.md")
        ]);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=discovery-context.test.js.map