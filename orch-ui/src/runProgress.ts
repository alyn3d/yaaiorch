import type { ActivityKind, RoundView, RunView, TaskView } from "./types";

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  read: "Requested a file read",
  search: "Requested a file search",
  edit: "Requested a file edit",
  command: "Requested a command",
  skill: "Requested a skill",
  web: "Requested a web tool",
  agent: "Requested a subagent",
  other: "Requested a tool",
  limit: "Activity limit reached; further requests are not shown",
};

export const isActivity = (value: unknown): value is ActivityKind => typeof value === "string" && Object.hasOwn(ACTIVITY_LABELS, value);

export function taskTimeline(tasks: TaskView[], now: number, live: boolean) {
  const rows = tasks.flatMap((task) => {
    const start = task.startedAt;
    if (start === undefined || !Number.isFinite(start)) return [];
    const recordedEnd = task.endedAt !== undefined && Number.isFinite(task.endedAt) && task.endedAt >= start ? task.endedAt : undefined;
    const running = live && task.status === "running" && recordedEnd === undefined;
    const end = recordedEnd ?? (running ? Math.max(start, now) : start);
    return [{ task, start, end, knownEnd: recordedEnd !== undefined || running, running }];
  });
  if (!rows.length) return null;
  rows.sort((a, b) => a.start - b.start || a.task.id - b.task.id);
  const start = rows[0].start;
  const end = Math.max(...rows.map((row) => row.end));
  const span = Math.max(end - start, 1);
  return {
    span: end - start,
    rows: rows.map((row) => ({ ...row, offset: row.start - start, left: ((row.start - start) / span) * 100, width: ((row.end - row.start) / span) * 100 })),
  };
}

type PhaseState = "pending" | "active" | "done" | "failed" | "attention" | "skipped" | "waiting" | "interrupted";
type Phase = { label: string; state: PhaseState };

function tasksState(tasks: TaskView[], planned: boolean, live: boolean): PhaseState {
  if (!planned) return live ? "pending" : "skipped";
  if (!tasks.length || tasks.every((t) => t.status === "SKIPPED")) return "skipped";
  if (live && tasks.some((t) => t.status === "running")) return "active";
  if (tasks.some((t) => ["FAILED", "FAIL", "ERROR"].includes(t.status))) return "failed";
  if (tasks.some((t) => ["PARTIAL", "PHANTOM", "UNKNOWN"].includes(t.status))) return "attention";
  if (tasks.some((t) => ["queued", "running", "STOPPED"].includes(t.status))) return live ? "pending" : "interrupted";
  return "done";
}

/** Only show an active phase when an event actually identifies it. */
export function roundPhases(run: RunView, round: RoundView): Phase[] {
  const live = run.status === "running" && run.rounds.at(-1) === round && round.passed === undefined;
  const planned = !!round.planned || !!round.summary || round.tasks.length > 0;
  const plan: PhaseState =
    round.mode === "direct" ? "skipped" : run.approval?.round === round.round && live ? "waiting" : planned ? "done" : live ? "active" : "interrupted";
  const forPhase = (phase: TaskView["phase"]) =>
    tasksState(
      round.tasks.filter((t) => t.phase === phase),
      planned,
      live,
    );
  const checks: PhaseState = round.checks
    ? !round.checks.length
      ? "skipped"
      : round.checks.some((c) => !c.ok)
        ? "failed"
        : "done"
    : round.checksStarted
      ? live
        ? "active"
        : "interrupted"
      : !live
        ? "skipped"
        : "pending";
  const phases: Phase[] = [
    { label: "Plan", state: plan },
    { label: "Foundation", state: forPhase("foundation") },
    { label: "Build", state: forPhase("build") },
    { label: "Checks", state: checks },
  ];
  if (round.visualStarted || round.visual) {
    phases.push({
      label: "Browser",
      state: round.visual ? (round.visual.problems.length ? "failed" : "done") : live ? "active" : "interrupted",
    });
  }
  phases.push({ label: "QA", state: forPhase("verify") });
  if (run.dryRun && run.status === "passed") {
    for (const phase of phases.slice(1)) phase.state = "skipped";
  }
  return phases;
}

export function failureSummary(run: RunView): { round: number; issues: string[]; note?: string; previous: boolean } | null {
  if (run.status === "passed") return null;
  for (let i = run.rounds.length - 1; i >= 0; i--) {
    const r = run.rounds[i];
    const issues = r.failures.length
      ? r.failures
      : [
          ...r.tasks.flatMap((t) =>
            t.error
              ? [`${t.agent}: ${t.error}`]
              : t.failures.length
                ? t.failures.map((f) => `${t.agent}: ${f}`)
                : ["FAILED", "FAIL", "ERROR", "PARTIAL", "PHANTOM", "UNKNOWN"].includes(t.status)
                  ? [`${t.agent}: ${t.status.toLowerCase()}`]
                  : [],
          ),
          ...(r.checks ?? []).filter((c) => !c.ok).map((c) => `Check "${c.name}" failed (exit ${c.code ?? "unknown"}).`),
          ...(r.visual?.problems ?? []).map((p) => `Browser check: ${p}`),
          ...(r.reviews ?? []).filter((review) => !review.approved).flatMap((review) => review.issues.map((issue) => `${review.agent}: ${issue}`)),
        ];
    if (issues.length || r.passed === false) {
      return { round: r.round, issues: issues.length ? [...new Set(issues)] : ["The round did not pass."], note: r.note, previous: i < run.rounds.length - 1 };
    }
  }
  return null;
}
