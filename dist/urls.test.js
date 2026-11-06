import test from "node:test";
import assert from "node:assert/strict";
import { baseUrl, ideaUrl, inboxUrl, issueUrl, projectPath } from "./urls.js";
import { loadInitTemplates } from "./config-templates.js";
const templates = await loadInitTemplates();
const urls = templates.urls;
const profile = {
    ziki: { baseUrl: "https://ziki.dev/", projectId: "project_zedu", projectSlug: "desktop", platform: "desktop" },
    urls: JSON.parse(JSON.stringify(urls))
};
const profileWithOrg = {
    ziki: {
        baseUrl: "https://ziki.dev",
        projectId: "c1",
        projectSlug: "desktop",
        platform: "desktop",
        orgSlug: "zedu"
    },
    urls: JSON.parse(JSON.stringify(urls))
};
test("projectPath nests under the org only when known", () => {
    assert.equal(projectPath(profile), "desktop");
    assert.equal(projectPath(profileWithOrg), "zedu/desktop");
});
test("issue and idea URLs mirror Ziki's /{org}/{project} layout", () => {
    assert.equal(issueUrl(profileWithOrg, { number: 2267 }), "https://ziki.dev/zedu/desktop/2267");
    assert.equal(ideaUrl(profileWithOrg, { number: 5 }), "https://ziki.dev/zedu/desktop/ideas/5");
    assert.equal(issueUrl(profile, { number: 1 }), "https://ziki.dev/desktop/1");
    assert.equal(inboxUrl(profile), "https://ziki.dev/inbox");
});
test("URL paths come from policy, not code", () => {
    const custom = {
        ziki: { baseUrl: "https://ziki.dev", projectId: "c1", projectSlug: "demo", platform: "web" },
        urls: { issuePath: "/w/{project}/i/{issue}", ideaPath: "/w/{project}/n/{idea}", inboxPath: "/box" }
    };
    assert.equal(issueUrl(custom, { number: 7 }), "https://ziki.dev/w/demo/i/7");
    assert.equal(ideaUrl(custom, { number: 3 }), "https://ziki.dev/w/demo/n/3");
    assert.equal(inboxUrl(custom), "https://ziki.dev/box");
    assert.throws(() => issueUrl({ ziki: custom.ziki }, { number: 1 }), /urls\.issuePath/);
});
test("baseUrl trims trailing slashes", () => {
    assert.equal(baseUrl(profile), "https://ziki.dev");
});
//# sourceMappingURL=urls.test.js.map