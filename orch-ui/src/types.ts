/** `note`: why a pending goal is waiting, e.g. "usage limit: retrying after …". */
export type Item = { id: number; goal: string; status: "pending" | "running" | "done" | "failed"; note?: string };
export type Round = { round: number; plan: string; touched: string[]; passed: boolean; failures: string[]; power?: Power; cost?: number };
/** .orchestrator/last-run.json, written by orch.ts. `checkpoint` is set only while that branch still exists. */
export type LastRun = { goal: string; status?: "running" | "passed" | "failed"; checkpoint?: string; cost?: number; state: Round[] } | null;
export type Running = { pid: number; label: string; startedAt: number } | null;
/** One repo's state. `queued`: a start is waiting (for a free slot, the usage limit or the daily budget); `waitReason` says which. */
export type State = { repo: string; running: Running; queued?: boolean; waitReason?: string; queue: Item[]; lastRun: LastRun };
/** Shared by all repos: the usage-limit hold and the daily budget. */
export type UsageWindow = "fiveHour" | "week";
export type Global = {
  usageLimit: { repo: string; until: number } | null;
  budget: { limit: number | null; spent: number; day: string };
  /** Latest subscription usage per window (percent, reset time in ms), from any repo's agent calls. */
  usage: Partial<Record<UsageWindow, { pct: number; resetsAt: number }>>;
  /** Percent caps per window; null = none. */
  usageCap: Record<UsageWindow, number | null>;
};
export type Power = "max" | "heavy" | "balanced" | "economy";
/** One of the user's Claude Code plugins (`orch plugins --json --details`). `enabled`: on in Claude Code itself. */
export type Plugin = { id: string; name: string; scope: string; enabled: boolean; tokens?: number };
/** One line of `orch doctor --json`. */
export type Finding = { name: string; level: "ok" | "warn" | "fail"; detail: string };

export type OrchEvent = { type: string; t: number; [k: string]: any };
export type TaskView = {
  id: number;
  agent: string;
  phase: "foundation" | "build" | "verify";
  task: string;
  files: string[];
  status: "queued" | "running" | string; // then COMPLETE | PARTIAL | FAILED | PHANTOM | UNKNOWN | ERROR | SKIPPED | STOPPED | PASS | FAIL
  touched: string[];
  failures: string[];
  error?: string;
  cost?: number;
  startedAt?: number;
  endedAt?: number;
};
export type RoundView = {
  round: number;
  power?: Power;
  /** Effective model per role this round (after overrides and escalation). */
  models?: Record<string, string>;
  /** "direct" for the fast path's single-agent attempt. */
  mode?: string;
  architect: "running" | "done";
  architectCost?: number;
  summary: string;
  tasks: TaskView[];
  checks?: { name: string; command: string; ok: boolean; code: number | null; ms: number }[];
  passed?: boolean;
  failures: string[];
  cost?: number;
  /** From a `stuck` event: why the next round escalates, or why the goal stopped. */
  note?: string;
};
export type RunView = {
  goal: string;
  maxRounds: number;
  dryRun: boolean;
  status: "running" | "passed" | "failed";
  error?: string;
  checkpoint?: string;
  maxCost?: number;
  /** From a `waiting` event: the usage limit (or the usage window over a cap) resets around this time (ms). */
  waitingUntil?: number;
  /** `usage_limit` (the subscription's limit was hit) or `usage_cap` (paused at the user's own cap). */
  waitingReason?: string;
  /** Sum of the costs reported so far; `goal_end` replaces it with the exact total. */
  cost: number;
  startedAt: number;
  rounds: RoundView[];
};
