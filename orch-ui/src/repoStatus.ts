import type { Session } from "./useOrch";

export const baseName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
export const usd = (n: number) => `$${n.toFixed(2)}`;

/** What a repo is doing right now, or how its last goal ended: a tone for the dot and a label. */
export function repoStatus(s: Session, now = Date.now()): { tone: string; label: string } {
  if (s.state.running && s.run?.waitingUntil && s.run.waitingUntil > now) return { tone: "warn", label: "waiting for the usage limit" };
  if (s.state.running && s.state.queue.some((i) => i.note?.startsWith("usage limit"))) return { tone: "warn", label: "waiting for the usage limit" };
  if (s.state.running) return { tone: "running", label: s.state.running.label };
  if (s.state.queued) return { tone: "warn", label: `waiting: ${s.state.waitReason ?? "free slot"}` };
  const last = s.run?.status ?? s.state.lastRun?.status;
  if (last === "failed") return { tone: "failed", label: "last goal failed" };
  if (last === "passed") return { tone: "done", label: "last goal passed" };
  return { tone: "", label: "idle" };
}
