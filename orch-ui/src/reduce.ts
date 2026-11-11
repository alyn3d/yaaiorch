import type { OrchEvent, RoundView, RunView, TaskView } from "./types";

const upd = (run: RunView, round: number, fn: (r: RoundView) => RoundView): RunView => ({
  ...run,
  rounds: run.rounds.map((r) => (r.round === round ? fn(r) : r)),
});
const updTask = (r: RoundView, id: number, fn: (t: TaskView) => TaskView): RoundView => ({
  ...r,
  tasks: r.tasks.map((t) => (t.id === id ? fn(t) : t)),
});

/** Fold one structured orchestrator event into the run view. */
export function reduce(run: RunView | null, ev: OrchEvent): RunView | null {
  switch (ev.type) {
    case "goal_start":
      return { goal: ev.goal, maxRounds: ev.maxRounds, dryRun: ev.dryRun, status: "running", startedAt: ev.t, rounds: [] };
    case "goal_end":
      return run && { ...run, status: ev.passed ? "passed" : "failed", error: ev.error };
    case "round_start":
      return run && { ...run, rounds: [...run.rounds, { round: ev.round, architect: "running", summary: "", tasks: [], failures: [] }] };
    case "plan":
      return (
        run &&
        upd(run, ev.round, (r) => ({
          ...r,
          architect: "done",
          summary: ev.summary,
          tasks: ev.tasks.map((t: any): TaskView => ({
            id: t.id, agent: t.agent, phase: t.phase, task: t.task, files: t.files ?? [],
            status: "queued", touched: [], failures: [],
          })),
        }))
      );
    case "task_start":
      return run && upd(run, ev.round, (r) => updTask(r, ev.id, (t) => ({ ...t, status: "running", startedAt: ev.t })));
    case "task_end":
      return (
        run &&
        upd(run, ev.round, (r) =>
          updTask(r, ev.id, (t) => ({
            ...t, status: ev.status, touched: ev.touched ?? [], failures: ev.failures ?? [], error: ev.error, endedAt: ev.t,
          })),
        )
      );
    case "round_end":
      return run && upd(run, ev.round, (r) => ({ ...r, passed: ev.passed, failures: ev.failures }));
    case "checks":
      return run && upd(run, ev.round, (r) => ({ ...r, checks: ev.results }));
    case "checkpoint":
      return run && { ...run, checkpoint: ev.branch };
    case "stopped": // synthetic (useOrch): the process exited without a goal_end, e.g. killed by Stop
      return run && run.status === "running"
        ? {
            ...run,
            status: "failed",
            error: run.error ?? "Stopped before the goal finished",
            rounds: run.rounds.map((r) => ({
              ...r,
              architect: "done",
              tasks: r.tasks.map((t) =>
                t.status === "running" || t.status === "queued" ? { ...t, status: "STOPPED", endedAt: t.startedAt && ev.t } : t,
              ),
            })),
          }
        : run;
    default:
      return run;
  }
}
