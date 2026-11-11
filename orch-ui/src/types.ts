export type Item = { id: number; goal: string; status: "pending" | "running" | "done" | "failed" };
export type Round = { round: number; plan: string; touched: string[]; passed: boolean; failures: string[] };
export type LastRun = { goal: string; state: Round[] } | null;
export type Running = { pid: number; label: string; startedAt: number } | null;
export type State = { repo: string | null; running: Running; queue: Item[]; lastRun: LastRun };
export type Power = "max" | "heavy" | "balanced" | "economy";

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
  startedAt?: number;
  endedAt?: number;
};
export type RoundView = {
  round: number;
  architect: "running" | "done";
  summary: string;
  tasks: TaskView[];
  checks?: { name: string; command: string; ok: boolean; code: number | null; ms: number }[];
  passed?: boolean;
  failures: string[];
};
export type RunView = {
  goal: string;
  maxRounds: number;
  dryRun: boolean;
  status: "running" | "passed" | "failed";
  error?: string;
  checkpoint?: string;
  startedAt: number;
  rounds: RoundView[];
};
