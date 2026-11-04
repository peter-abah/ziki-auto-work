import type { PlatformRef } from "./types.js";
import { ZikiClient } from "./ziki.js";

export interface KeyProject {
  id: string;
  slug: string;
  name: string;
}

export interface KeyInspection {
  envName: string;
  key: string;
  ok: boolean;
  agent?: string;
  level?: string;
  projectId?: string;
  projectSlug?: string;
  projectName?: string;
  projects?: KeyProject[];
  error?: string;
}

export async function inspectKey(
  envName: string,
  key: string,
  baseUrl = "https://ziki.dev"
): Promise<KeyInspection> {
  try {
    const client = new ZikiClient({ baseUrl, apiKey: key, projectId: "", projectSlug: "" });
    const me = await client.me();
    const projects: KeyProject[] = Array.isArray(me?.projects)
      ? me.projects
          .filter((project: any) => project && project.id && project.slug)
          .map((project: any) => ({
            id: String(project.id),
            slug: String(project.slug),
            name: String(project.name ?? project.slug)
          }))
      : [];
    const own = projects.find((project) => project.id === me?.project_id);
    return {
      envName,
      key,
      ok: true,
      agent: me?.name ?? "(unknown)",
      level: me?.level ?? "(unknown)",
      projectId: me?.project_id ?? undefined,
      projectSlug: me?.project_slug ?? undefined,
      projectName: own?.name,
      projects
    };
  } catch (error) {
    return {
      envName,
      key,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function inspectKeys(
  env: Record<string, string>,
  baseUrl = "https://ziki.dev"
): Promise<KeyInspection[]> {
  const names = Object.keys(env).filter((name) => name.startsWith("ZIKI_") && env[name]);
  return Promise.all(names.map((name) => inspectKey(name, env[name]!, baseUrl)));
}

export function assignRoles(items: KeyInspection[]): { workers: string[]; managers: string[] } {
  const workers: string[] = [];
  const managers: string[] = [];
  for (const item of items) {
    if (!item.ok) continue;
    const level = String(item.level ?? "").toLowerCase();
    if (level === "manager" || level === "merger") managers.push(item.envName);
    else workers.push(item.envName);
  }
  return { workers, managers };
}

export function formatKeyTable(items: KeyInspection[]): string {
  const rows = [
    ["ENV", "AGENT", "LEVEL", "PROJECT"],
    ...items.map((item) =>
      item.ok
        ? [item.envName, item.agent ?? "?", item.level ?? "?", item.projectSlug ?? "?"]
        : [item.envName, "INVALID", "-", item.error ?? "error"]
    )
  ];
  const widths = rows[0]!.map((_, index) => Math.max(...rows.map((row) => String(row[index] ?? "").length)));
  return rows
    .map((row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index]!)).join("  ").trimEnd())
    .join("\n");
}

export function projectSummary(items: KeyInspection[]): { id: string; slug: string; name?: string } | null {
  const counts = new Map<string, { id: string; slug: string; name?: string; count: number }>();
  for (const item of items) {
    if (!item.ok || !item.projectId || !item.projectSlug) continue;
    const key = `${item.projectId}:${item.projectSlug}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { id: item.projectId, slug: item.projectSlug, name: item.projectName, count: 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return best ? { id: best.id, slug: best.slug, name: best.name } : null;
}

export function knownProjects(items: KeyInspection[]): KeyProject[] {
  const seen = new Map<string, KeyProject>();
  for (const item of items) {
    for (const project of item.projects ?? []) {
      if (!seen.has(project.id)) seen.set(project.id, project);
    }
  }
  return [...seen.values()];
}

export async function listPlatforms(baseUrl: string, key: string): Promise<PlatformRef[]> {
  const client = new ZikiClient({ baseUrl, apiKey: key, projectId: "", projectSlug: "" });
  const data = await client.platforms();
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  return items
    .filter((item: any) => item && item.slug)
    .map((item: any) => ({
      id: String(item.id ?? ""),
      slug: String(item.slug),
      name: String(item.name ?? item.slug)
    }));
}
