import type { ZikiConfig } from "./types.js";
/**
 * Config-driven Ziki endpoints.
 *
 * Every Ziki URL the client calls lives here as a template, so URL-shape
 * changes (new path segments, renamed routes, org prefixes) are fixed in
 * CONFIG — never in code. The agent may propose template/vars changes through
 * the approval-gated repair flow; see RepairConfig.
 *
 * Placeholders:
 * - `{name}` — required; interpolated from vars + identity fields. Unknown
 *   names are a config validation error, never a silent wrong URL.
 * - `{name?}` — optional; drops out with slash-collapse when empty/absent.
 *
 * Built-in identity vars (always available, no declaration needed):
 * `projectId`, `projectSlug`, `orgSlug`, `platform`.
 */
export declare const BUILTIN_IDENTITY_VARS: readonly ["projectId", "projectSlug", "orgSlug", "platform"];
export declare const DEFAULT_ENDPOINTS: Record<string, Record<string, string>>;
/** Inputs available for endpoint interpolation; every field is optional. */
export interface EndpointVarsInput {
    vars?: Record<string, string | undefined> | undefined;
    projectId?: string | undefined;
    projectSlug?: string | undefined;
    orgSlug?: string | null | undefined;
    platform?: string | undefined;
}
/** All variables available for interpolation: explicit vars + identity fields. */
export declare function endpointVars(ziki: EndpointVarsInput): Record<string, string>;
/**
 * Render one endpoint template. Required vars missing → throw (fail loud,
 * never a silently wrong URL). Optional `{var?}` drops out with
 * slash-collapse. Relative paths only — absolute URLs and schemes are
 * rejected (base URL stays immutable).
 */
export declare function renderEndpoint(template: string, vars: Record<string, unknown>): string;
/** Resolve a named endpoint against profile config (falls back to built-ins). */
export declare function resolveEndpoint(ziki: Pick<ZikiConfig, "endpoints" | "vars" | "projectId" | "projectSlug" | "orgSlug" | "platform">, group: string, name: string, params?: Record<string, string | number>): string;
/** Validate a user/agent-supplied endpoints map. Returns error strings (empty = valid). */
export declare function validateEndpoints(endpoints: unknown, knownVars: string[], label?: string): string[];
/** Validate a vars map. */
export declare function validateEndpointVars(vars: unknown, label?: string): string[];
/**
 * Split a work feed URL like `https://ziki.dev/zedu/desktop/work` into
 * `{ org, project }`. Returns null when the shape is unrecognized.
 */
export declare function parseWorkUrl(workUrl: string | null | undefined): {
    org: string;
    project: string;
} | null;
