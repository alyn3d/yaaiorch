import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const DIR = join(".orchestrator", "runs");
const ID = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

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
  return path;
}

export function appendRunHistory(path: string, event: HistoryEvent) {
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function readRunHistory(id: string): { events: HistoryEvent[]; truncated: boolean } {
  const path = historyPath(id);
  checkDirectory();
  if (!lstatSync(path).isFile()) throw new Error(`run history ${id} is not a regular file`);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const truncated = lines.pop() !== "";
  const events = lines.map((line, i) => {
    try {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string" || !("t" in event) || typeof event.t !== "number")
        throw new Error("invalid event");
      return event as HistoryEvent;
    } catch {
      throw new Error(`invalid run history ${id}, line ${i + 1}`);
    }
  });
  if (events[0]?.type !== "goal_start" || typeof events[0].goal !== "string" || typeof events[0].maxRounds !== "number")
    throw new Error(`run history ${id} has no valid goal start`);
  return { events, truncated };
}

export function listRunHistory(): HistoryEntry[] {
  let names: string[];
  try {
    checkDirectory();
    names = readdirSync(DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((name) => name.endsWith(".jsonl") && ID.test(name.slice(0, -6)))
    .sort()
    .reverse()
    .map((name): HistoryEntry => {
      const id = name.slice(0, -6);
      try {
        const { events, truncated } = readRunHistory(id);
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
      } catch (e) {
        return { id, status: "unreadable", error: e instanceof Error ? e.message : String(e) };
      }
    });
}
