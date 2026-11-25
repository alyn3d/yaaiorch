// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import type { Session } from "./useOrch";

export const baseName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
export const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * "waiting for the usage limit" / "paused at your usage cap" while a run's `waiting` has not run out, else null. The
 * caller checks that the process is live: a run that waits out a limit has already ended that attempt (`goal_end`).
 */
export function waitLabel(run: Session["run"] | undefined, now = Date.now()): string | null {
  if (!run?.waitingUntil || run.waitingUntil <= now) return null;
  return run.waitingReason === "usage_cap" ? "paused at your usage cap" : "waiting for the usage limit";
}

/**
 * A group run's waits: the group's own (its coordinator call) and each member repo's run, as "who: label until time".
 * Only while the group runs; a member's wait counts only when its run is part of this group run (`inGroup`).
 */
export function groupWaits(group: Session["run"] | undefined, members: { role: string; session?: Session }[], now = Date.now()): string[] {
  if (group?.status !== "running") return [];
  const at = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const out: string[] = [];
  const own = waitLabel(group, now);
  if (own) out.push(`coordinator: ${own} until ${at(group.waitingUntil!)}`);
  for (const { role, session } of members) {
    const label = session?.state.inGroup ? waitLabel(session.run, now) : null;
    if (label) out.push(`${role}: ${label} until ${at(session!.run!.waitingUntil!)}`);
  }
  return out;
}

/** What a repo is doing right now, or how its last goal ended: a tone for the dot and a label. */
export function repoStatus(s: Session, now = Date.now()): { tone: string; label: string } {
  const waiting = s.state.running || s.state.inGroup ? waitLabel(s.run, now) : null;
  if (waiting) return { tone: "warn", label: waiting };
  if (s.state.running && s.state.queue.some((i) => i.note?.startsWith("usage limit"))) return { tone: "warn", label: "waiting for the usage limit" };
  if (s.state.running && (s.run?.approval || s.run?.group?.approval)) return { tone: "warn", label: "waiting for your plan approval" };
  if (s.state.inGroup && !s.state.running) return { tone: "running", label: `in group ${s.state.inGroup}` };
  if (s.state.running) return { tone: "running", label: s.state.running.label };
  if (s.state.queued) return { tone: "warn", label: `waiting: ${s.state.waitReason ?? "free slot"}` };
  const last = s.run?.status ?? s.state.lastRun?.status;
  if (last === "failed") return { tone: "failed", label: "last goal failed" };
  if (last === "passed") return { tone: "done", label: "last goal passed" };
  return { tone: "", label: "idle" };
}
