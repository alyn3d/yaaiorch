import type { Session } from "./useOrch";

export const BOARD_LANES = ["Working", "Needs you", "In review", "Done"] as const;
export type BoardLane = (typeof BOARD_LANES)[number];
export type BoardCard = {
  key: string;
  repo: string;
  context: string;
  title: string;
  detail: string;
  lane: BoardLane;
};

/** Build the overview board from current task, question, approval, PR, CI and queue state. */
export function overviewBoard(sessions: Record<string, Session>, order: string[], now: number): Record<BoardLane, BoardCard[]> {
  const lanes: Record<BoardLane, BoardCard[]> = { Working: [], "Needs you": [], "In review": [], Done: [] };
  const add = (lane: BoardLane, card: Omit<BoardCard, "lane">) => lanes[lane].push({ ...card, lane });

  for (const repo of order) {
    const session = sessions[repo];
    const run = session?.run;
    if (!session) continue;
    for (const item of session.state.queue.filter((item) => item.status === "done"))
      add("Done", {
        key: `${repo}:queue:${item.id}`,
        repo,
        context: `#${item.id}`,
        title: item.goal,
        detail: [
          item.issue ? `Issue #${item.issue}` : item.fromSpec ? "Brief goal" : "Queue goal",
          item.cost !== undefined ? `$${item.cost.toFixed(2)}` : null,
          item.seconds !== undefined ? `${Math.round(item.seconds / 60)}m` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    if (!run) continue;
    const round = run.rounds.at(-1);
    const base = { repo, context: run.goal };

    for (const question of run.questions?.filter((q) => !q.answered) ?? [])
      add("Needs you", {
        ...base,
        key: `${repo}:question:${question.id}`,
        title: `${question.agent} needs a decision`,
        detail: question.question,
      });

    if (run.approval)
      add("Needs you", {
        ...base,
        key: `${repo}:approval:${run.approval.round}`,
        title: "Plan approval",
        detail: run.approval.summary,
      });

    if (run.status === "running" && run.waitingUntil && run.waitingUntil > now)
      add("Needs you", {
        ...base,
        key: `${repo}:wait:${run.waitingUntil}`,
        title: "Waiting for usage reset",
        detail: new Date(run.waitingUntil).toLocaleString(),
      });

    if (run.status === "failed")
      add("Needs you", {
        ...base,
        key: `${repo}:failed:${run.startedAt}`,
        title: "Goal failed",
        detail: run.error ?? round?.failures[0] ?? "Open the run for details.",
      });

    if (run.pr?.url)
      add("In review", {
        ...base,
        key: `${repo}:pr:${run.pr.url}`,
        title: "Pull request",
        detail: run.ci ? `CI ${run.ci.state}${run.ci.failed.length ? ` · ${run.ci.failed.join(", ")}` : ""}` : "Waiting for CI",
      });

    if (run.status !== "running" || !session.state.running) continue;
    const activeTasks = round?.tasks.filter((task) => task.status === "running") ?? [];
    for (const task of activeTasks) {
      const lane: BoardLane = task.phase === "verify" ? "In review" : "Working";
      add(lane, {
        ...base,
        key: `${repo}:task:${round!.round}:${task.id}`,
        title: task.task,
        detail: `${task.agent} · ${task.phase}`,
      });
    }

    if (round?.checksStarted && !round.checks)
      add("In review", {
        ...base,
        key: `${repo}:checks:${round.round}`,
        title: "Running checks",
        detail: round.summary || "Verifying the changes",
      });

    if (!activeTasks.length && !round?.checksStarted && !run.approval && !(run.waitingUntil && run.waitingUntil > now))
      add("Working", {
        ...base,
        key: `${repo}:run:${round?.round ?? 0}`,
        title: round?.architect === "running" ? "Architect · planning" : "Run in progress",
        detail: round?.summary || session.state.running.label,
      });
  }

  return lanes;
}
