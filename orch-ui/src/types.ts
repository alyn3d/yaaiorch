/** `note`: why a pending goal is waiting, e.g. "usage limit: retrying after …". */
export type Item = {
  id: number;
  goal: string;
  status: "pending" | "running" | "done" | "failed" | "blocked";
  note?: string;
  /** Ids of the goals it needs first. */
  after?: number[];
  attempts?: number;
  fromSpec?: boolean;
  /** The brief it came from. */
  brief?: string;
  /** Cost and time of its runs so far. */
  cost?: number;
  seconds?: number;
  /** The GitHub issue it came from (orch intake). */
  issue?: number;
  /** 1 (first) to 9; 3 when not set. */
  priority?: number;
};
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheCreation: number };
export type RoundDiff = { text?: string; truncated?: boolean; unavailable?: string };
export type Round = {
  round: number;
  plan: string;
  touched: string[];
  passed: boolean;
  failures: string[];
  power?: Power;
  cost?: number;
  tokens?: TokenUsage;
  diff?: RoundDiff;
};
/** .orchestrator/last-run.json, written by orch.ts. `checkpoint` is set only while that branch still exists. */
export type LastRun = {
  goal: string;
  status?: "running" | "passed" | "failed";
  checkpoint?: string;
  cost?: number;
  tokens?: TokenUsage;
  state: Round[];
} | null;
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
export type RosterEntry = { name: string; description: string; source: "builtin" | "user" | "project"; content: string };
export type RosterSkill = { name: string; description: string; source: "user" | "project" };
export type AgentRoster = { agents: RosterEntry[]; skills: RosterSkill[] };
/** One line of `orch doctor --json`. */
export type Finding = { name: string; level: "ok" | "warn" | "fail"; detail: string };

export type OrchEvent = { type: string; t: number; [k: string]: any };
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
export type HistoryRecording = { events: OrchEvent[]; truncated: boolean };
export type ActivityKind = "read" | "search" | "edit" | "command" | "skill" | "web" | "agent" | "other" | "limit";
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
  report?: string;
  reportTruncated?: boolean;
  activity?: { kind: ActivityKind; t: number }[];
  cost?: number;
  tokens?: TokenUsage;
  startedAt?: number;
  endedAt?: number;
  /** Continued the agent's session from this earlier round. */
  resumed?: number;
};
export type RoundView = {
  round: number;
  power?: Power;
  /** Effective model per role this round (after overrides and escalation). */
  models?: Record<string, string>;
  /** "direct" for the fast path's single-agent attempt. */
  mode?: string;
  architect: "running" | "done";
  planned?: boolean;
  architectCost?: number;
  architectTokens?: TokenUsage;
  summary: string;
  tasks: TaskView[];
  checks?: { name: string; command: string; ok: boolean; code: number | null; ms: number }[];
  checksStarted?: boolean;
  visualStarted?: boolean;
  passed?: boolean;
  failures: string[];
  cost?: number;
  tokens?: TokenUsage;
  diff?: RoundDiff;
  /** From a `stuck` event: why the next round escalates, or why the goal stopped. */
  note?: string;
  /** From a `critic` event: the plan critic's review (`revised`: the architect re-planned after a rejection). */
  critic?: { approved: boolean; issues: string[]; revised: boolean; cost?: number; tokens?: TokenUsage };
  /** From `review` events: diff reviews next to QA (lens "goal": the critic; "bugs": a reviewer). */
  reviews?: { agent: string; lens: "goal" | "bugs"; approved: boolean; issues: string[]; cost?: number; tokens?: TokenUsage }[];
  /** From an `unowned` event: files changed outside every task's list (`strict`: that failed the round). */
  unowned?: { files: string[]; strict: boolean };
  /** From a `visual` event: the browser check before QA (`problems` failed the round; screenshots under .orchestrator/visual/). */
  visual?: { url: string; shots: { path: string; viewport: number; theme: string; file: string }[]; problems: string[]; observations: string[]; ms: number };
};
export type RunView = {
  goal: string;
  /** --branch: the goal's branch and where it started (`goal_branch`); --pr: the pull request (`pr`). */
  branch?: { name: string; base: string };
  pr?: { url?: string; error?: string };
  /** --pr: the pull request's CI checks (`ci` events): pass, fail, none, timeout. */
  ci?: { state: string; failed: string[] };
  /** --approve-plan: the plan waiting for an answer (`approval_wait`), cleared by `approval`. */
  approval?: { round: number; summary: string; tasks: { agent: string; phase: string; task: string; files?: string[] }[]; error?: string };
  maxRounds: number;
  dryRun: boolean;
  status: "running" | "passed" | "failed";
  endedAt?: number;
  historyError?: string;
  error?: string;
  checkpoint?: string;
  maxCost?: number;
  /** From a `waiting` event: the usage limit (or the usage window over a cap) resets around this time (ms). */
  waitingUntil?: number;
  /** `usage_limit` (the subscription's limit was hit) or `usage_cap` (paused at the user's own cap). */
  waitingReason?: string;
  /** Sum of the costs reported so far; `goal_end` replaces it with the exact total. */
  cost: number;
  /** Sum of agent-call token usage; `goal_end` replaces it with the exact total. */
  tokens?: TokenUsage;
  startedAt: number;
  rounds: RoundView[];
};
