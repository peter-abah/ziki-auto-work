import type {
  HealthBlocker,
  HealthComponent,
  HealthSeverity,
  HealthSummary,
  LoopHealth
} from "./types.js";
import { ZikiError } from "./ziki.js";
import { isTransientNetworkError } from "./network.js";

export interface HealthReport {
  component: HealthComponent;
  code: string;
  severity: HealthSeverity;
  message: string;
  agents?: string[];
  details?: Record<string, unknown>;
  retryMs?: number | null;
}

export interface HealthUpdate {
  blocker: HealthBlocker;
  changed: boolean;
  created: boolean;
}

const RETRY_MS = {
  profile: 5 * 60_000,
  auth: 5 * 60_000,
  permission: 5 * 60_000,
  config: 5 * 60_000,
  rateLimit: 15 * 60_000,
  network: 60_000,
  generic: 5 * 60_000
};

export function emptyHealth(): LoopHealth {
  return { state: "healthy", blockers: {}, lastCheckAt: null };
}

export function summarizeHealth(health: LoopHealth): HealthSummary {
  const blockers = Object.values(health.blockers ?? {}).sort((a, b) => {
    const rank = { blocked: 0, degraded: 1, warning: 2 };
    return rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id);
  });
  const state = blockers.some((blocker) => blocker.severity === "blocked")
    ? "blocked"
    : blockers.some((blocker) => blocker.severity === "degraded")
      ? "degraded"
      : blockers.length
        ? "degraded"
        : "healthy";
  return { state, blockers };
}

export function blockerId(component: HealthComponent, code: string): string {
  return `${component}:${code}`;
}

function bodyRecord(error: ZikiError): Record<string, unknown> {
  return error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : {};
}

export function classifyError(error: unknown, component: HealthComponent): HealthReport {
  if (error instanceof ZikiError) {
    const body = bodyRecord(error);
    const code = String(body.error ?? "");
    const message = String(body.message ?? error.message);
    if (code === "profile_incomplete") {
      return {
        component: "agent",
        code: "profile_incomplete",
        severity: "blocked",
        message,
        details: {
          missing: body.missing ?? [],
          setupUrl: body.setup_url ?? null,
          helpUrl: body.help_url ?? null,
          status: error.status
        },
        retryMs: RETRY_MS.profile
      };
    }
    if (error.status === 401) {
      return { component, code: "auth", severity: "blocked", message, retryMs: RETRY_MS.auth };
    }
    if (error.status === 403) {
      return { component, code: "permission", severity: "blocked", message, retryMs: RETRY_MS.permission };
    }
    if (error.status === 429) {
      return { component, code: "rate_limit", severity: "degraded", message, retryMs: RETRY_MS.rateLimit };
    }
    if (error.status >= 500) {
      return { component, code: "network", severity: "degraded", message, retryMs: RETRY_MS.network };
    }
    if (error.status === 404) {
      return { component, code: "not_found", severity: "blocked", message, retryMs: RETRY_MS.config };
    }
    if (error.status === 422 && /unknown platform|unknown .* id|unknown filter/i.test(`${code} ${message}`)) {
      // Stable code for restructured Ziki taxonomies (categories/areas renamed
      // server-side). Per-item failures stay warnings; the repair flow can
      // propose a filter remap. See config-repair strategy "*:unknown_filter".
      return { component, code: "unknown_filter", severity: "warning", message, retryMs: RETRY_MS.config };
    }
    return { component, code: code || "error", severity: "warning", message, retryMs: RETRY_MS.generic };
  }
  if (isTransientNetworkError(error)) {
    return {
      component,
      code: "network",
      severity: "degraded",
      message: error instanceof Error ? error.message : String(error),
      retryMs: RETRY_MS.network
    };
  }
  return {
    component,
    code: "error",
    severity: "warning",
    message: error instanceof Error ? error.message : String(error),
    retryMs: RETRY_MS.generic
  };
}

export function reportBlocker(
  health: LoopHealth,
  report: HealthReport,
  now = Date.now()
): HealthUpdate {
  const id = blockerId(report.component, report.code);
  const at = new Date(now).toISOString();
  const existing = health.blockers[id];
  const agents = report.agents?.filter(Boolean).sort();
  const nextRetryAt =
    report.retryMs === null
      ? null
      : new Date(now + (report.retryMs ?? RETRY_MS.generic)).toISOString();
  if (!existing) {
    const blocker: HealthBlocker = {
      id,
      component: report.component,
      code: report.code,
      severity: report.severity,
      message: report.message,
      agents,
      details: report.details,
      since: at,
      lastAttemptAt: at,
      attempts: 1,
      nextRetryAt,
      notifiedAt: null
    };
    health.blockers[id] = blocker;
    health.lastCheckAt = at;
    health.state = summarizeHealth(health).state;
    return { blocker, changed: true, created: true };
  }
  const changed =
    existing.severity !== report.severity ||
    existing.message !== report.message ||
    JSON.stringify(existing.agents ?? []) !== JSON.stringify(agents ?? []) ||
    JSON.stringify(existing.details ?? {}) !== JSON.stringify(report.details ?? {});
  existing.severity = report.severity;
  existing.message = report.message;
  existing.agents = agents;
  existing.details = report.details ?? existing.details;
  existing.lastAttemptAt = at;
  existing.attempts += 1;
  existing.nextRetryAt = nextRetryAt;
  health.lastCheckAt = at;
  health.state = summarizeHealth(health).state;
  return { blocker: existing, changed, created: false };
}

export function clearBlocker(health: LoopHealth, component: HealthComponent, code?: string): HealthBlocker[] {
  const removed: HealthBlocker[] = [];
  for (const [id, blocker] of Object.entries(health.blockers ?? {})) {
    if (blocker.component !== component) continue;
    if (code && blocker.code !== code) continue;
    removed.push(blocker);
    delete health.blockers[id];
  }
  health.lastCheckAt = new Date().toISOString();
  health.state = summarizeHealth(health).state;
  return removed;
}

export function nextRetryDelay(health: LoopHealth, now = Date.now()): number | null {
  const times = Object.values(health.blockers ?? {})
    .filter((blocker) => blocker.severity !== "warning")
    .map((blocker) => (blocker.nextRetryAt ? Date.parse(blocker.nextRetryAt) : NaN))
    .filter((value) => Number.isFinite(value) && value > now);
  return times.length ? Math.max(0, Math.min(...times) - now) : null;
}

export function healthLabel(health: LoopHealth): string {
  const summary = summarizeHealth(health);
  if (summary.state === "healthy") return "healthy";
  const top = summary.blockers[0];
  if (!top) return summary.state;
  const agents = top.agents?.length ? ` (${top.agents.join(", ")})` : "";
  return `${summary.state}: ${top.code}${agents}`;
}
