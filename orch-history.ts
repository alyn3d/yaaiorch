// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const DIR = join(".orchestrator", "runs");
const ID = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Runs kept on disk; older ones are removed when a new run starts (ORCH_HISTORY_KEEP overrides). */
const KEEP = 200;
/** Listing reads a run's first line from the first HEAD bytes and its goal_end from the last TAIL bytes. */
const HEAD = 64 * 1024;
const TAIL = 256 * 1024;

export type HistoryEvent = { type: string; t: number; [key: string]: unknown };
export type HistoryEntry = {
  id: string;
  goal?: string;
  startedAt?: number;
  endedAt?: number;
  status: "passed" | "failed" | "unfinished" | "unreadable";
  cost?: number;
  truncated?: boolean;
  error?: string;
};

function historyPath(id: string): string {
  if (!ID.test(id)) throw new Error("invalid run history id");
  return join(DIR, `${id}.jsonl`);
}

function checkDirectory() {
  if (!lstatSync(DIR).isDirectory()) throw new Error("run history directory is not a directory");
}

export function createRunHistory(): string {
  mkdirSync(DIR, { recursive: true });
  checkDirectory();
  const path = historyPath(`${Date.now()}-${randomUUID()}`);
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
  pruneRunHistory(path);
  return path;
}

/** Keep the newest runs (KEEP, or ORCH_HISTORY_KEEP), never the one just created. */
function pruneRunHistory(current: string) {
  const keep = Math.max(1, Number(process.env.ORCH_HISTORY_KEEP) || KEEP);
  const names = runNames();
  for (const name of names.slice(keep)) {
    const path = join(DIR, name);
    if (path !== current) rmSync(path, { force: true });
  }
}

/** Run files, newest first (ids start with the start time in ms). */
function runNames(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".jsonl") && ID.test(name.slice(0, -6)))
    .sort()
    .reverse();
}

export function appendRunHistory(path: string, event: HistoryEvent) {
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

/** One line as an event; `where` names it in the error. */
function parseEvent(line: string, id: string, where: string): HistoryEvent {
  try {
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string" || !("t" in event) || typeof event.t !== "number")
      throw new Error("invalid event");
    return event as HistoryEvent;
  } catch {
    throw new Error(`invalid run history ${id}, ${where}`);
  }
}

function checkStart(start: HistoryEvent | undefined, id: string): HistoryEvent {
  if (start?.type !== "goal_start" || typeof start.goal !== "string" || typeof start.maxRounds !== "number")
    throw new Error(`run history ${id} has no valid goal start`);
  return start;
}

function regularFile(id: string): string {
  const path = historyPath(id);
  checkDirectory();
  if (!lstatSync(path).isFile()) throw new Error(`run history ${id} is not a regular file`);
  return path;
}

export function readRunHistory(id: string): { events: HistoryEvent[]; truncated: boolean } {
  const text = readFileSync(regularFile(id), "utf8");
  const lines = text.split("\n");
  const truncated = lines.pop() !== "";
  const events = lines.map((line, i) => parseEvent(line, id, `line ${i + 1}`));
  checkStart(events[0], id);
  return { events, truncated };
}

/**
 * A run's summary without reading all of it: the goal_start line from the head and the last goal_end from the
 * tail, whose complete lines are checked too. Small files, and runs whose goal_end is not near the end, are read
 * in full. Damage in the middle of a large file shows only when the run is opened.
 */
function summarize(id: string): HistoryEntry {
  const path = regularFile(id);
  const fd = openSync(path, "r");
  let start: HistoryEvent;
  let tail: HistoryEvent[];
  let truncated: boolean;
  try {
    const size = fstatSync(fd).size;
    if (size <= HEAD + TAIL) return entryFrom(id, readRunHistory(id));
    const head = Buffer.alloc(HEAD);
    readSync(fd, head, 0, HEAD, 0);
    const firstEnd = head.indexOf(10);
    if (firstEnd < 0) return entryFrom(id, readRunHistory(id));
    start = checkStart(parseEvent(head.subarray(0, firstEnd).toString("utf8"), id, "line 1"), id);
    const end = Buffer.alloc(TAIL);
    readSync(fd, end, 0, TAIL, size - TAIL);
    const lines = end
      .subarray(end.indexOf(10) + 1)
      .toString("utf8")
      .split("\n");
    truncated = lines.pop() !== "";
    tail = lines.map((line) => parseEvent(line, id, "near the end"));
  } finally {
    closeSync(fd);
  }
  if (!tail.some((e) => e.type === "goal_end")) return entryFrom(id, readRunHistory(id));
  return entryFrom(id, { events: [start, ...tail], truncated });
}

function entryFrom(id: string, { events, truncated }: { events: HistoryEvent[]; truncated: boolean }): HistoryEntry {
  const start = events[0];
  const end = events.findLast((event) => event.type === "goal_end");
  return {
    id,
    goal: start.goal as string,
    startedAt: start.t,
    endedAt: end?.t,
    status: end ? (end.passed === true ? "passed" : "failed") : "unfinished",
    cost: typeof end?.cost === "number" ? end.cost : undefined,
    truncated: truncated || undefined,
  };
}

/** Past runs, newest first; `limit`: only the newest that many (the others are not read). */
export function listRunHistory(limit?: number): HistoryEntry[] {
  let names: string[];
  try {
    checkDirectory();
    names = runNames();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names.slice(0, limit ?? names.length).map((name): HistoryEntry => {
    const id = name.slice(0, -6);
    try {
      return summarize(id);
    } catch (e) {
      return { id, status: "unreadable", error: e instanceof Error ? e.message : String(e) };
    }
  });
}
