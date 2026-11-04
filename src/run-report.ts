import { mkdir, writeFile } from "node:fs/promises";
import type { ProfileConfig, ProfilePaths, RunSummary, State, StopReason } from "./types.js";
import { inboxUrl } from "./urls.js";
import { emptyUsage } from "./usage.js";

export function buildRunSummary(options: {
  state: State;
  profileName: string;
  profile: ProfileConfig;
  clean: boolean;
  stopReason: StopReason | "killed";
  endedAt?: string | null;
}): RunSummary {
  const { state, profileName, profile, clean, stopReason } = options;
  const startedAt = state.run.startedAt ?? state.lastRun?.startedAt ?? state.startedAt ?? new Date().toISOString();
  const started = new Date(startedAt).getTime();
  const tasks = Object.values(state.tasks);
  const touched = tasks
    .filter((task) => new Date(task.updatedAt).getTime() >= started)
    .map((task) => ({
      number: task.number ?? "?",
      title: task.title,
      status: task.status,
      pr: task.prUrl ?? null
    }));
  const open = Object.values(state.escalations).filter((escalation) => escalation.status === "open");
  const activity = [
    state.lastCycleAt,
    ...tasks.map((task) => task.updatedAt)
  ].filter((value): value is string => Boolean(value));
  const lastActivityAt = activity.sort().at(-1) ?? startedAt;
  return {
    profile: profileName,
    startedAt,
    endedAt: options.endedAt ?? (clean ? new Date().toISOString() : null),
    clean,
    stopReason,
    cycles: state.cycles,
    deliveries: state.run.deliveries,
    reviews: state.run.reviews,
    mergeReviews: state.run.mergeReviews,
    discoveries: state.run.discoveries,
    aux: state.run.aux,
    failures: state.run.failures,
    networkErrors: state.run.networkErrors ?? 0,
    interrupted: clean ? 0 : tasks.filter((task) => ["claimed", "working"].includes(task.status)).length,
    needsYou: open.length,
    needsYouLink: inboxUrl(profile),
    issues: touched,
    tokens: state.run.tokens ?? emptyUsage(),
    lastActivityAt
  };
}

export function formatRunSummary(summary: RunSummary, options: { files?: boolean; inProgress?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(
    options.inProgress
      ? "Auto-work run in progress"
      : summary.clean
        ? "Auto-work run finished"
        : "Previous auto-work run did not shut down cleanly"
  );
  lines.push(`Profile:       ${summary.profile}`);
  lines.push(`Started:       ${summary.startedAt}`);
  if (summary.endedAt) lines.push(`Ended:         ${summary.endedAt}`);
  else lines.push(`Last activity: ${summary.lastActivityAt ?? "unknown"}`);
  lines.push(`Duration:      ${formatDuration(summary.startedAt, summary.endedAt ?? summary.lastActivityAt)}`);
  lines.push(`Stopped:       ${summary.stopReason ?? "-"}`);
  lines.push(`Cycles:        ${summary.cycles}`);
  lines.push(`Deliveries:    ${summary.deliveries}`);
  lines.push(`Reviews:       ${summary.reviews}`);
  lines.push(`Merge reviews: ${summary.mergeReviews}`);
  lines.push(`Discoveries:   ${summary.discoveries}`);
  lines.push(`Aux:           ${summary.aux}`);
  lines.push(`Failures:      ${summary.failures}`);
  lines.push(`Network errors:${summary.networkErrors ? ` ${summary.networkErrors}` : " 0"}`);
  const tokens = summary.tokens ?? { input: 0, output: 0, total: 0 };
  lines.push(
    `Tokens:        ${tokens.total.toLocaleString()} (${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out)${tokens.estimated ? " estimated" : ""}${tokens.costUsd !== undefined ? ` · $${tokens.costUsd.toFixed(4)}` : ""}`
  );
  lines.push(`Interrupted:   ${summary.interrupted}`);

  const deliveries = summary.issues.filter((issue) => issue.status === "delivered");
  if (deliveries.length) {
    lines.push(
      `Delivered:     ${deliveries
        .slice(0, 10)
        .map((issue) => `#${issue.number}${issue.pr ? ` ${issue.pr}` : ""}`)
        .join(", ")}`
    );
  }
  const failures = summary.issues.filter((issue) => issue.status === "failed");
  if (failures.length) {
    lines.push(`Failed:        ${failures.slice(0, 10).map((issue) => `#${issue.number}`).join(", ")}`);
  }
  lines.push(
    `Ziki needs you: ${summary.needsYou}${summary.needsYouLink ? ` → ${summary.needsYouLink}` : ""}`
  );
  if (options.files) lines.push("Files:         LAST-RUN.md · history.jsonl");
  return lines.join("\n");
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "unknown";
  const minutes = Math.floor((end - start) / 60000);
  if (minutes < 1) return `${Math.max(1, Math.round((end - start) / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export async function writeRunSummary(profilePaths: ProfilePaths, summary: RunSummary): Promise<void> {
  await mkdir(profilePaths.stateDir, { recursive: true });
  await writeFile(profilePaths.lastRunFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(profilePaths.lastRunMdFile, `# Auto-work run\n\n${formatRunSummary(summary, { files: false })}\n`, "utf8");
}
