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
      return {
        goal: ev.goal,
        maxRounds: ev.maxRounds,
        dryRun: ev.dryRun,
        maxCost: ev.maxCost,
        status: "running",
        startedAt: ev.t,
        rounds: [],
        cost: 0,
      };
    case "goal_end":
      return (
        run && {
          ...run,
          status: ev.passed ? "passed" : "failed",
          error: ev.usageLimit && ev.resetAt ? `${ev.error} (resets ${new Date(ev.resetAt).toLocaleString()})` : ev.error,
          cost: ev.cost ?? run.cost,
        }
      );
    case "round_start":
      return (
        run && {
          ...run,
          rounds: [
            ...run.rounds,
            {
              round: ev.round,
              power: ev.power,
              models: ev.models,
              mode: ev.mode,
              architect: ev.mode === "direct" ? "done" : "running",
              summary: "",
              tasks: [],
              failures: [],
            },
          ],
        }
      );
    case "plan":
      return (
        run &&
        upd({ ...run, cost: run.cost + (ev.cost ?? 0) }, ev.round, (r) => ({
          ...r,
          architect: "done",
          architectCost: ev.cost,
          summary: ev.summary,
          tasks: ev.tasks.map((t: any): TaskView => ({
            id: t.id,
            agent: t.agent,
            phase: t.phase,
            task: t.task,
            files: t.files ?? [],
            status: "queued",
            touched: [],
            failures: [],
          })),
        }))
      );
    case "task_start":
      return run && upd(run, ev.round, (r) => updTask(r, ev.id, (t) => ({ ...t, status: "running", startedAt: ev.t, resumed: ev.resumed })));
    case "task_end":
      return (
        run &&
        upd({ ...run, cost: run.cost + (ev.cost ?? 0) }, ev.round, (r) =>
          updTask(r, ev.id, (t) => ({
            ...t,
            status: ev.status,
            touched: ev.touched ?? [],
            failures: ev.failures ?? [],
            error: ev.error,
            cost: ev.cost,
            endedAt: ev.t,
          })),
        )
      );
    case "round_end":
      return run && upd(run, ev.round, (r) => ({ ...r, passed: ev.passed, failures: ev.failures, cost: ev.cost }));
    case "stuck":
      return (
        run &&
        upd(run, ev.round, (r) => ({
          ...r,
          note:
            ev.action === "stop"
              ? `No progress again (${ev.reason}): stopped the goal.`
              : ev.action === "escalate" && ev.agents
                ? `No progress (${ev.reason}): only the failing tasks move up next round (${Object.entries(ev.agents as Record<string, string>)
                    .map(([a, p]) => `${a} at ${p}`)
                    .join(", ")}).`
                : ev.action === "escalate"
                  ? `No progress (${ev.reason}): next round runs at power ${ev.power}.`
                  : `No progress (${ev.reason}): already at max power, retrying with a different approach.`,
        }))
      );
    case "unowned":
      return run && upd(run, ev.round, (r) => ({ ...r, unowned: { files: ev.files ?? [], strict: !!ev.strict } }));
    case "approval_wait":
      return run && { ...run, approval: { round: ev.round, summary: ev.summary, tasks: ev.tasks ?? [], error: ev.error } };
    case "approval":
      return run && { ...run, approval: undefined };
    case "goal_branch":
      return run && { ...run, branch: { name: ev.branch, base: ev.base } };
    case "pr":
      return run && { ...run, pr: { url: ev.url, error: ev.error } };
    case "review":
      return (
        run &&
        upd({ ...run, cost: run.cost + (ev.cost ?? 0) }, ev.round, (r) => ({
          ...r,
          reviews: [...(r.reviews ?? []), { agent: ev.agent, lens: ev.lens, approved: !!ev.approved, issues: ev.issues ?? [], cost: ev.cost }],
        }))
      );
    case "critic":
      return run && upd(run, ev.round, (r) => ({ ...r, critic: { approved: !!ev.approved, issues: ev.issues ?? [], revised: !!ev.revised, cost: ev.cost } }));
    case "waiting":
      return run && { ...run, waitingUntil: ev.until, waitingReason: ev.reason };
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
              tasks: r.tasks.map((t) => (t.status === "running" || t.status === "queued" ? { ...t, status: "STOPPED", endedAt: t.startedAt && ev.t } : t)),
            })),
          }
        : run;
    default:
      return run;
  }
}
