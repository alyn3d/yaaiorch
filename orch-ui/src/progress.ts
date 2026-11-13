// Progress of the latest brief in a repo's queue: pure, so it can be unit-tested.
import type { Item } from "./types";

export type BriefProgress = {
  total: number;
  done: number;
  failed: number;
  blocked: number;
  running?: Item;
  /** What its goals have cost so far (all attempts). */
  cost: number;
  /** A rough guess: the average time of the goals finished so far times the goals still to run; undefined before one finished. */
  secondsLeft?: number;
};

/** For the goals of the newest brief in the queue (goals from `orch split` / `orch new`), or null if there are none. */
export function briefProgress(queue: Item[]): BriefProgress | null {
  const latest = [...queue].reverse().find((i) => i.brief)?.brief;
  const mine = latest ? queue.filter((i) => i.brief === latest) : queue.filter((i) => i.fromSpec);
  if (!mine.length) return null;
  const count = (s: Item["status"]) => mine.filter((i) => i.status === s).length;
  const finished = mine.filter((i) => (i.status === "done" || i.status === "failed") && i.seconds);
  const toRun = count("pending") + count("running");
  const avg = finished.length ? finished.reduce((n, i) => n + (i.seconds ?? 0), 0) / finished.length : undefined;
  return {
    total: mine.length,
    done: count("done"),
    failed: count("failed"),
    blocked: count("blocked"),
    running: mine.find((i) => i.status === "running"),
    cost: mine.reduce((n, i) => n + (i.cost ?? 0), 0),
    secondsLeft: avg === undefined ? undefined : Math.round(avg * toRun),
  };
}

/** "about 25 min left", "about 2 h left", "under a minute left". */
export function leftText(seconds: number): string {
  if (seconds < 60) return "under a minute left";
  const min = Math.round(seconds / 60);
  return min < 90 ? `about ${min} min left` : `about ${Math.round(min / 60)} h left`;
}
