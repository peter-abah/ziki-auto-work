import type { ReviewGatePolicyConfig } from "./types.js";

export interface ReviewGateStatus {
  state: string;
  merged: boolean;
  checks: string;
  mergeable: boolean | null;
  isDraft?: boolean;
}

export interface ReviewGateInput {
  status: ReviewGateStatus | null;
  goodVerdicts?: number;
  verdictsNeeded?: number | null;
  policy: ReviewGatePolicyConfig;
}

export interface ReviewGateResult {
  ok: boolean;
  reason?: string;
  recentMs?: number;
}

function requireMs(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number (run \`auto-work migrate\`)`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${path} must be a non-empty string (run \`auto-work migrate\`)`);
  }
  return value;
}

export function verdictsNeeded(
  workflow: Record<string, unknown> | null | undefined,
  keys: readonly string[] = ["verdictsNeeded", "testVerdictsNeeded", "requiredTestVerdicts", "reviewsRequired"]
): number | null {
  const raw = keys.map((key) => workflow?.[key]).find((value) => value !== undefined);
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
  const { status, goodVerdicts = 0, verdictsNeeded: needed = null, policy } = input;
  const transientMs = requireMs(policy.transientMs, "profile.reviewGate.transientMs");
  const terminalMs = requireMs(policy.terminalMs, "profile.reviewGate.terminalMs");
  const openState = requireString(policy.openState, "profile.reviewGate.openState");
  const failing = requireString(policy.checkStates?.failing, "profile.reviewGate.checkStates.failing");
  const pending = requireString(policy.checkStates?.pending, "profile.reviewGate.checkStates.pending");
  if (!status) {
    return { ok: false, reason: "PR status unavailable", recentMs: transientMs };
  }
  if (status.merged) {
    return { ok: false, reason: "PR is already merged", recentMs: terminalMs };
  }
  if (status.state !== openState) {
    return { ok: false, reason: `PR is ${status.state.toLowerCase()}`, recentMs: terminalMs };
  }
  if (status.isDraft) {
    return { ok: false, reason: "PR is still a draft", recentMs: transientMs };
  }
  if (status.checks === failing) {
    return { ok: false, reason: "PR checks are failing", recentMs: transientMs };
  }
  if (status.checks === pending) {
    return { ok: false, reason: "PR checks are still pending", recentMs: transientMs };
  }
  if (status.mergeable === false) {
    return { ok: false, reason: "PR has merge conflicts", recentMs: transientMs };
  }
  if (needed !== null && goodVerdicts >= needed) {
    return {
      ok: false,
      reason: `issue already has ${goodVerdicts} good-to-merge verdict(s); ${needed} needed`,
      recentMs: terminalMs
    };
  }
  return { ok: true };
}
