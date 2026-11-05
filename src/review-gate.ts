export interface ReviewGateStatus {
  state: string;
  merged: boolean;
  checks: "passing" | "failing" | "pending" | "none";
  mergeable: boolean | null;
  isDraft?: boolean;
}

export interface ReviewGateInput {
  status: ReviewGateStatus | null;
  goodVerdicts?: number;
  verdictsNeeded?: number | null;
}

export interface ReviewGateResult {
  ok: boolean;
  reason?: string;
  recentMs?: number;
}

const TRANSIENT_RECENT_MS = 5 * 60_000;
const TERMINAL_RECENT_MS = 30 * 60_000;

export function verdictsNeeded(workflow: Record<string, unknown> | null | undefined): number | null {
  const raw =
    workflow?.verdictsNeeded ??
    workflow?.testVerdictsNeeded ??
    workflow?.requiredTestVerdicts ??
    workflow?.reviewsRequired;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}


export interface VerdictLike {
  goodToMerge?: boolean;
  current?: boolean;
  agentId?: string;
  id?: string;
}

export function countGoodVerdicts(verdicts: ReadonlyArray<VerdictLike>): number {
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    if (verdict.goodToMerge !== true || verdict.current === false) continue;
    const key = verdict.agentId || verdict.id || `verdict-${seen.size}`;
    seen.add(key);
  }
  return seen.size;
}

export function reviewGate(input: ReviewGateInput): ReviewGateResult {
  const { status, goodVerdicts = 0, verdictsNeeded: needed = null } = input;
  if (!status) {
    return { ok: false, reason: "PR status unavailable", recentMs: TRANSIENT_RECENT_MS };
  }
  if (status.merged) {
    return { ok: false, reason: "PR is already merged", recentMs: TERMINAL_RECENT_MS };
  }
  if (status.state !== "OPEN") {
    return { ok: false, reason: `PR is ${status.state.toLowerCase()}`, recentMs: TERMINAL_RECENT_MS };
  }
  if (status.isDraft) {
    return { ok: false, reason: "PR is still a draft", recentMs: TRANSIENT_RECENT_MS };
  }
  if (status.checks === "failing") {
    return { ok: false, reason: "PR checks are failing", recentMs: TRANSIENT_RECENT_MS };
  }
  if (status.checks === "pending") {
    return { ok: false, reason: "PR checks are still pending", recentMs: TRANSIENT_RECENT_MS };
  }
  if (status.mergeable === false) {
    return { ok: false, reason: "PR has merge conflicts", recentMs: TRANSIENT_RECENT_MS };
  }
  if (needed !== null && goodVerdicts >= needed) {
    return {
      ok: false,
      reason: `issue already has ${goodVerdicts} good-to-merge verdict(s); ${needed} needed`,
      recentMs: TERMINAL_RECENT_MS
    };
  }
  return { ok: true };
}
