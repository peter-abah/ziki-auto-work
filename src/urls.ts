import type { Idea, Issue, ProfileConfig, UrlsPolicyConfig } from "./types.js";

export function baseUrl(profile: ProfileConfig): string {
  return profile.ziki.baseUrl.replace(/\/+$/, "");
}

/** Project path segment: `org/project` when the org is known, else the legacy bare slug. */
export function projectPath(profile: ProfileConfig): string {
  const project = profile.ziki.projectSlug;
  const org = profile.ziki.orgSlug?.trim();
  return org ? `${org}/${project}` : project;
}

function urlTemplates(profile: ProfileConfig): { issuePath: string; ideaPath: string; inboxPath: string } {
  const urls = profile.urls as UrlsPolicyConfig | undefined;
  for (const key of ["issuePath", "ideaPath", "inboxPath"] as const) {
    const value = urls?.[key];
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error(`urls.${key} must be a relative path starting with "/" (run \`auto-work migrate\`)`);
    }
  }
  return {
    issuePath: urls?.issuePath as string,
    ideaPath: urls?.ideaPath as string,
    inboxPath: urls?.inboxPath as string
  };
}

/**
 * Render a URL path template. `{name}` interpolates; `{name?}` drops out
 * with slash-collapse when empty/absent (e.g. `{org?}` for tenants without
 * organisations). Unknown placeholders fail loud.
 */
function renderUrlPath(template: string, vars: Record<string, string | undefined>): string {
  const rendered = template.replace(/\{([A-Za-z0-9_]+)(\?)?\}/g, (_match, name: string, optional: string | undefined) => {
    const value = vars[name];
    if (value === undefined || value === null || value === "") {
      if (optional) return "";
      throw new Error(`URL template needs $${name}, which is not set`);
    }
    return value;
  });
  if (/\{[A-Za-z0-9_]+\??\}/.test(rendered)) {
    throw new Error(`unresolved placeholder left in URL: ${rendered}`);
  }
  return rendered.replace(/\/{2,}/g, "/");
}

export function issueUrl(profile: ProfileConfig, issue: { number: number | string }): string {
  const { issuePath } = urlTemplates(profile);
  const path = renderUrlPath(issuePath, {
    org: profile.ziki.orgSlug?.trim(),
    project: profile.ziki.projectSlug,
    issue: String(issue.number)
  });
  return `${baseUrl(profile)}${path}`;
}

export function ideaUrl(profile: ProfileConfig, idea: { number: number | string }): string {
  const { ideaPath } = urlTemplates(profile);
  const path = renderUrlPath(ideaPath, {
    org: profile.ziki.orgSlug?.trim(),
    project: profile.ziki.projectSlug,
    idea: String(idea.number)
  });
  return `${baseUrl(profile)}${path}`;
}

export function inboxUrl(profile: ProfileConfig): string {
  const { inboxPath } = urlTemplates(profile);
  return `${baseUrl(profile)}${renderUrlPath(inboxPath, {})}`;
}

export function escalationUrl(profile: ProfileConfig, issueNumber: number | string | null): string {
  return issueNumber ? issueUrl(profile, { number: issueNumber }) : inboxUrl(profile);
}

export function issueLabel(issue: Issue | { number: number | string; title: string }): string {
  return `#${issue.number} ${issue.title}`;
}

export function ideaLabel(idea: Idea | { number: number | string; title: string }): string {
  return `idea #${idea.number} ${idea.title}`;
}
