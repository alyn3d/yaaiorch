// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import type { GroupView, OrchEvent, RoundView, RunView, TaskView, TokenUsage } from "./types";
import { isActivity } from "./runProgress";

const addTokens = (a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined => {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
};

const upd = (run: RunView, round: number, fn: (r: RoundView) => RoundView): RunView => ({
  ...run,
  rounds: run.rounds.map((r) => (r.round === round ? fn(r) : r)),
});
const updTask = (r: RoundView, id: number, fn: (t: TaskView) => TaskView): RoundView => ({
  ...r,
  tasks: r.tasks.map((t) => (t.id === id ? fn(t) : t)),
});

/** Without the keys whose value is undefined: a step's skipped/failed must not linger from the step before. */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const updGroup = (run: RunView | null, fn: (g: GroupView) => GroupView): RunView | null => (run && run.group ? { ...run, group: fn(run.group) } : run);

/** Fold one structured orchestrator event into the run view. */
export function reduce(run: RunView | null, ev: OrchEvent): RunView | null {
  switch (ev.type) {
    case "group_child": {
      // A member's own event, wrapped by `orch group run`: the backends route it to that repo's session; here only
      // when no session has that repo. The group's view survives a child's goal_start.
      if (!ev.event || typeof ev.event !== "object" || typeof ev.event.type !== "string") return run;
      const next = reduce(run, ev.event as OrchEvent);
      return next && run?.group && next.group !== run.group ? { ...next, group: run.group } : next;
    }
    case "group_start":
      return {
        goal: ev.goal,
        maxRounds: ev.maxRounds ?? 0,
        dryRun: false,
        status: "running",
        startedAt: ev.t,
        rounds: [],
        cost: 0,
        group: { name: ev.group, goal: ev.goal, repos: Array.isArray(ev.repos) ? ev.repos : [] },
      };
    case "group_plan":
      return run?.group
        ? updGroup({ ...run, cost: run.cost + (ev.cost ?? 0) }, (g) => ({ ...g, contract: ev.contract, ...(ev.revised ? {} : { goals: ev.goals }) }))
        : run;
    case "group_approval_wait":
      return updGroup(run, (g) => ({ ...g, approval: { round: ev.round, contract: ev.contract ?? "", goals: ev.goals ?? {} } }));
    case "group_approval":
      return updGroup(run, (g) => defined({ ...g, approval: undefined }));
    case "group_step":
      return updGroup(run, (g) =>
        defined({ ...g, step: ev.step, stepRepo: ev.repo, round: ev.round, skipped: ev.skipped, failed: ev.failed, external: ev.external }),
      );
    case "group_fault":
      return run?.group ? updGroup({ ...run, cost: run.cost + (ev.cost ?? 0) }, (g) => ({ ...g, fault: { side: ev.fault, goals: ev.goals ?? {} } })) : run;
    case "group_end":
      return run?.group
        ? updGroup({ ...run, status: ev.ok ? "passed" : "failed", endedAt: ev.t, error: ev.reason }, (g) => ({
            ...g,
            ok: !!ev.ok,
            reason: ev.reason,
            parked: ev.parked,
            kept: ev.kept,
          }))
        : run;
    case "group_rollback":
      return updGroup(run, (g) => ({ ...g, rolledBack: true, rolledBackParked: ev.parked }));
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
          endedAt: ev.t,
          error: ev.usageLimit && ev.resetAt ? `${ev.error} (resets ${new Date(ev.resetAt).toLocaleString()})` : ev.error,
          cost: ev.cost ?? run.cost,
          tokens: ev.tokens ?? run.tokens,
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
        upd({ ...run, cost: run.cost + (ev.cost ?? 0), tokens: addTokens(run.tokens, ev.tokens) }, ev.round, (r) => ({
          ...r,
          architect: "done",
          planned: true,
          architectCost: ev.cost,
          architectTokens: ev.tokens,
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
    case "task_activity":
      return run && isActivity(ev.activity)
        ? upd(run, ev.round, (r) =>
            updTask(r, ev.id, (t) => (t.status === "running" ? { ...t, activity: [...(t.activity ?? []), { kind: ev.activity, t: ev.t }].slice(-8) } : t)),
          )
        : run;
    case "task_end":
      return (
        run &&
        upd({ ...run, cost: run.cost + (ev.cost ?? 0), tokens: addTokens(run.tokens, ev.tokens) }, ev.round, (r) =>
          updTask(r, ev.id, (t) => ({
            ...t,
            status: ev.status,
            touched: ev.touched ?? [],
            failures: ev.failures ?? [],
            error: ev.error,
            report: ev.report,
            reportTruncated: ev.reportTruncated,
            cost: ev.cost,
            tokens: ev.tokens,
            endedAt: ev.t,
          })),
        )
      );
    case "round_diff":
      return run && upd(run, ev.round, (r) => ({ ...r, diff: ev.diff }));
    case "round_end":
      return run && upd(run, ev.round, (r) => ({ ...r, passed: ev.passed, failures: ev.failures, cost: ev.cost, tokens: ev.tokens, diff: ev.diff }));
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
      // The architect is done; the round now waits for the user, not for planning.
      return (
        run &&
        upd({ ...run, approval: { round: ev.round, summary: ev.summary, tasks: ev.tasks ?? [], error: ev.error } }, ev.round, (r) => ({
          ...r,
          architect: "done",
        }))
      );
    case "approval":
      return run && { ...run, approval: undefined };
    case "question_wait":
      return (
        run && {
          ...run,
          questions: [
            ...(run.questions ?? []),
            { id: ev.id, agent: ev.agent, round: ev.round, taskId: ev.taskId, question: ev.question, options: ev.options, answered: false },
          ],
        }
      );
    case "question_answered":
      return run && { ...run, questions: run.questions?.map((q) => (q.id === ev.id ? { ...q, answered: true } : q)) };
    case "command_wait":
      return (
        run && {
          ...run,
          commands: [
            ...(run.commands ?? []),
            {
              id: ev.id,
              agent: ev.agent,
              round: ev.round,
              taskId: ev.taskId,
              tool: ev.tool,
              command: ev.command,
              description: ev.description,
              noAlways: ev.noAlways === true || undefined,
            },
          ],
        }
      );
    case "command_decided":
      return run && { ...run, commands: run.commands?.map((c) => (c.id === ev.id ? { ...c, decision: ev.decision ?? "deny" } : c)) };
    case "goal_branch":
      return run && { ...run, branch: { name: ev.branch, base: ev.base } };
    case "pr":
      return run && { ...run, pr: { url: ev.url, error: ev.error } };
    case "ci":
      return run && { ...run, ci: { state: ev.state, failed: ev.failed ?? [] } };
    case "review":
      return (
        run &&
        upd({ ...run, cost: run.cost + (ev.cost ?? 0), tokens: addTokens(run.tokens, ev.tokens) }, ev.round, (r) => ({
          ...r,
          reviews: [
            ...(r.reviews ?? []),
            { agent: ev.agent, lens: ev.lens, approved: !!ev.approved, issues: ev.issues ?? [], cost: ev.cost, tokens: ev.tokens },
          ],
        }))
      );
    case "critic":
      return (
        run &&
        upd(run, ev.round, (r) => ({
          ...r,
          critic: { approved: !!ev.approved, issues: ev.issues ?? [], revised: !!ev.revised, cost: ev.cost, tokens: ev.tokens },
        }))
      );
    case "notes_tidy":
      return run && { ...run, tokens: addTokens(run.tokens, ev.tokens) };
    case "waiting":
      return run && { ...run, waitingUntil: ev.until, waitingReason: ev.reason };
    case "checks":
      return run && upd(run, ev.round, (r) => ({ ...r, checks: ev.results }));
    case "checks_start":
      return run && upd(run, ev.round, (r) => ({ ...r, checksStarted: true }));
    case "visual_start":
      return run && upd(run, ev.round, (r) => ({ ...r, visualStarted: true }));
    case "visual":
      return (
        run &&
        upd(run, ev.round, (r) => ({
          ...r,
          visual: { url: ev.url, shots: ev.shots ?? [], problems: ev.problems ?? [], observations: ev.observations ?? [], ms: ev.ms ?? 0 },
        }))
      );
    case "checkpoint":
      return run && { ...run, checkpoint: ev.branch };
    case "history_error":
      return run && { ...run, historyError: ev.error };
    case "stopped": // synthetic (useOrch): the process exited without a goal_end, e.g. killed by Stop
      return run && run.status === "running"
        ? {
            ...run,
            status: "failed",
            endedAt: ev.t,
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
