import test from "node:test";
import assert from "node:assert/strict";
import type { ProfileConfig } from "./types.js";
import { baseUrl, ideaUrl, inboxUrl, issueUrl, projectPath } from "./urls.js";

const profile = {
  ziki: { baseUrl: "https://ziki.dev/", projectId: "project_zedu", projectSlug: "desktop", platform: "desktop" }
} as unknown as ProfileConfig;

const profileWithOrg = {
  ziki: {
    baseUrl: "https://ziki.dev",
    projectId: "c1",
    projectSlug: "desktop",
    platform: "desktop",
    orgSlug: "zedu"
  }
} as unknown as ProfileConfig;

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

test("baseUrl trims trailing slashes", () => {
  assert.equal(baseUrl(profile), "https://ziki.dev");
});
