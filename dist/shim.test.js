import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chooseShimPath, installShim } from "./shim.js";
test("chooseShimPath prefers an existing PATH directory", { skip: process.platform === "win32" }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "auto-work-shim-"));
    try {
        const local = path.join(home, ".local/bin");
        await mkdir(local, { recursive: true });
        const plan = chooseShimPath({
            platform: "linux",
            home,
            pathValue: `${local}${path.delimiter}${path.join(home, "bin")}`
        });
        assert.equal(plan?.dir, local);
        assert.equal(plan?.onPath, true);
        assert.equal(plan?.path, path.join(local, "auto-work"));
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
test("chooseShimPath uses the Windows npm dir", () => {
    const root = path.join(os.tmpdir(), "auto-work-win");
    const plan = chooseShimPath({
        platform: "win32",
        home: root,
        env: { APPDATA: root, PATH: path.join(root, "npm") },
        pathValue: path.join(root, "npm")
    });
    assert.equal(plan?.path, path.join(root, "npm", "auto-work.cmd"));
    assert.equal(plan?.onPath, true);
});
test("installShim creates a symlink to the package bin", { skip: process.platform === "win32" }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "auto-work-install-"));
    try {
        const packageRoot = path.join(home, "package");
        await mkdir(path.join(packageRoot, "bin"), { recursive: true });
        await writeFile(path.join(packageRoot, "bin", "auto-work.mjs"), "#!/usr/bin/env node\n", "utf8");
        const local = path.join(home, ".local/bin");
        await mkdir(local, { recursive: true });
        const result = await installShim({
            packageRoot,
            home,
            platform: "linux",
            pathValue: `${local}${path.delimiter}${process.env.PATH ?? ""}`
        });
        assert.ok(result);
        assert.equal(await readlink(result.plan.path), path.join(packageRoot, "bin", "auto-work.mjs"));
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
test("installShim writes a Windows cmd shim", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "auto-work-install-win-"));
    try {
        const packageRoot = path.join(home, "package");
        await mkdir(path.join(packageRoot, "bin"), { recursive: true });
        await writeFile(path.join(packageRoot, "bin", "auto-work.mjs"), "", "utf8");
        const appData = path.join(home, "AppData/Roaming");
        await mkdir(path.join(appData, "npm"), { recursive: true });
        const result = await installShim({
            packageRoot,
            home,
            platform: "win32",
            env: { APPDATA: appData, PATH: path.join(appData, "npm") },
            pathValue: path.join(appData, "npm")
        });
        assert.ok(result);
        assert.match(await readFile(result.plan.path, "utf8"), /auto-work\.mjs/);
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
//# sourceMappingURL=shim.test.js.map