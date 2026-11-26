// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

// The structured events orch prints as `@@ORCH@@ {json}` lines (with ORCH_EVENTS=1) and saves to the run history.
// One map from event type to payload, shared by the emitters (orch.ts, orch-group-run.ts) and the readers (the UI's
// reduce.ts, the browser server): a field renamed on one side fails the typecheck on the other.
//
// No imports and no runtime code besides EVENT_TYPES: the UI imports this file too. Payloads describe what orch sends
// today; readers of old run histories still guard against missing fields.

export type EventPower = "max" | "heavy" | "balanced" | "economy";
export type EventPhase = "foundation" | "build" | "verify";
export type EventGroupRole = "backend" | "frontend";
export type EventTokens = { input: number; output: number; cacheRead: number; cacheCreation: number };
export type EventRoundDiff = { text?: string; truncated?: boolean; unavailable?: string };
export type EventUsageWindow = "fiveHour" | "week";
export type EventUsage = Partial<Record<EventUsageWindow, { pct: number; resetsAt: number }>>;
/** What an agent is doing, from its tool calls; "limit" once a task has sent 49 and no more follow. */
export type EventActivity = "read" | "search" | "edit" | "command" | "skill" | "web" | "agent" | "other" | "limit";
export type EventVisualAction = { click: string } | { wait: string | number };
/** A plan task as the architect wrote it, with its index in the plan. */
export type EventPlanTask = {
  id: number;
  agent: string;
  phase: EventPhase;
  task: string;
  files?: string[];
  heavy?: boolean;
  figma?: string;
  skills?: string[];
  visual?: { path: string; selector?: string; actions?: EventVisualAction[]; viewports?: number[]; themes?: ("light" | "dark")[] }[];
};
/** Cost of one agent call (or a step's calls), with its token usage when the CLI reported one. */
type Cost = { cost: number; tokens?: EventTokens };
type Round = { round: number };

/** Every event type and its payload (besides `type` and `t`, which every event has). */
export interface OrchEventData {
  // ---------- goal ----------
  /** A goal starts. A CI fix goal (`ci`) carries only goal, rounds, power and budget. */
  goal_start: {
    goal: string;
    maxRounds: number;
    dryRun: boolean;
    power: EventPower;
    maxCost?: number;
    ci?: boolean;
    models?: { roles: Record<string, string>; agents: Record<string, string> };
    onLimit?: "wait" | "stop";
    usageCap?: Partial<Record<EventUsageWindow, number>>;
    plugins?: { off: boolean; disable: string[]; hooks: boolean };
    critic?: boolean;
    approvePlan?: boolean;
    branch?: boolean;
    worktrees?: boolean;
    pr?: boolean;
  };
  /** `usageLimit`: ended by the Claude usage limit, which resets at `resetAt` (ms). */
  goal_end: { passed: boolean; error?: string; usageLimit?: boolean; resetAt?: number } & Cost;
  checkpoint: { branch: string };
  /** An interrupted goal continues from its parked work. */
  resumed: { branch: string; commits: string[] };
  /** --branch: the goal's branch and where it started (`shared`: a brief's goals share it). */
  goal_branch: { branch: string; base: string; shared?: boolean };
  /** --pr: the pull request (`url`), or the host's page to open one (`link`) after a push. */
  pr: { branch: string; base: string; url?: string; link?: string; pushed?: boolean; updated?: boolean; error?: string };
  /** --pr: the pull request's CI checks. */
  ci: { pr: string; state: string; attempt: number; failed: string[] };
  usage_limit: { message: string; resetAt?: number };
  /** Paused until the usage limit resets, or until a usage window is back under the cap (`window`). */
  waiting: { reason: "usage_limit" | "usage_cap"; until?: number; window?: EventUsageWindow };
  /** The latest subscription usage readings. */
  usage: EventUsage;
  history_error: { error: string };

  // ---------- round ----------
  /** `mode` "direct": the fast path's single-agent attempt. `agentPower`: agents escalated on their own. */
  round_start: Round & { power: EventPower; models: Record<string, string>; mode?: "direct"; agentPower?: Record<string, EventPower> };
  architect_start: Round;
  plan: Round & Cost & { summary: string; tasks: EventPlanTask[] };
  /** --critic: the plan critic's review (`revised`: the architect re-planned after a rejection). */
  critic: Round & Cost & { approved: boolean; issues: string[]; revised: boolean };
  /** --approve-plan: the plan waits for a human (`error`: why the last edited plan was refused). */
  approval_wait: Round & { summary: string; tasks: EventPlanTask[]; error?: string };
  approval: Round & { action: string; edited: boolean };
  task_start: Round & { id: number; agent: string; phase: EventPhase; resumed?: number };
  task_activity: Round & { id: number; activity: EventActivity };
  /** `status`: COMPLETE, PARTIAL, FAILED, PHANTOM, UNKNOWN, ERROR, SKIPPED, STOPPED (implementers), PASS or FAIL (QA). */
  task_end: Round & {
    id: number;
    agent: string;
    phase: EventPhase;
    status: string;
    touched: string[];
    failures?: string[];
    error?: string;
    report?: string;
    reportTruncated?: boolean;
    cost?: number;
    tokens?: EventTokens;
  };
  /** Files changed outside every task's list (`strict`: that fails the round). */
  unowned: Round & { files: string[]; strict: boolean };
  protected: Round & { files: string[] };
  /** Where a secret was found and what kind; never the value. */
  secrets: Round & { found: { file: string; what: string }[] };
  round_diff: Round & { diff: EventRoundDiff };
  checks_start: Round;
  /** `gate`: a gate check (config gateChecks). `gateSkipped`: gate checks not run because an ordinary one failed. */
  checks: Round & {
    results: { name: string; command: string; ok: boolean; code: number | null; ms: number; gate?: boolean }[];
    gateSkipped?: string[];
  };
  /** A diff review next to QA: lens "goal" (the critic) or "bugs" (a reviewer). */
  review: Round & Cost & { agent: string; lens: "goal" | "bugs"; approved: boolean; issues: string[] };
  visual_start: Round;
  /** The browser check: `problems` fail the round, `observations` are for QA; screenshots under .orchestrator/visual/. */
  visual: Round & {
    url: string;
    shots: { target: number; path: string; viewport: number; theme: "light" | "dark"; file: string }[];
    problems: string[];
    observations: string[];
    ms: number;
  };
  round_end: Round & { passed: boolean; failures: string[]; cost: number; diff: EventRoundDiff; tokens?: EventTokens };
  /** A stuck round: escalate a tier (only `agents` when others completed), retry, or stop the goal. */
  stuck: Round & { action: "stop" | "escalate" | "retry"; reason: string; power?: EventPower; agents?: Record<string, EventPower | undefined> };

  // ---------- questions and commands ----------
  question_wait: { id: string; agent: string; round?: number; taskId?: number; question: string; options: string[] };
  question_answered: { id: string };
  /** --commands: a shell command waits for Agent M's answer (`noAlways`: no "always allow"; `prefix`: its rule). */
  command_wait: {
    id: string;
    agent: string;
    round?: number;
    taskId?: number;
    tool: string;
    command: string;
    description?: string;
    noAlways?: boolean;
    prefix?: string;
  };
  /** allow, always, prefix, deny, timeout or cancelled. */
  command_decided: { id: string; decision: string };

  // ---------- queue and loop ----------
  queue_item: { id: number; goal: string };
  queue_changed: { id: number };
  blocked: { id: number; goal: string; note?: string };
  retry: { id: number; attempt?: number; power?: EventPower };
  intake: { source: string; ids: number[] };
  loop_stop: { reason: "requested" | "budget"; spent?: number };
  /** A big brief split into goals (`queued`: false for a proposal waiting for the human; `after`: dependencies). */
  split_proposal: { goals: string[]; after: number[][]; checks?: Record<string, string>; queued: boolean; cost: number };
  /** The brief checked against the code once the queue ran dry: what is still missing. */
  coverage: Cost & { pass: number; missing: string[] };

  // ---------- repo knowledge ----------
  learn_start: { power: EventPower };
  learn_end: Cost & { ok: boolean };
  share_start: Record<string, never>;
  share_end: Cost & { ok: boolean; branch?: string };
  notes_tidy: Cost & { ok: boolean; before: number; after: number };

  // ---------- repo groups (orch group run) ----------
  group_start: { group: string; goal: string; repos: { path: string; role: EventGroupRole }[] };
  /** The contract and goals (`revised`: after a fault call; `edited`: by the human at approval). */
  group_plan: { contract: string; goals: Partial<Record<EventGroupRole, string>>; cost: number; edited?: boolean; revised?: boolean };
  group_approval_wait: Round & { contract: string; goals: Partial<Record<EventGroupRole, string>> };
  group_approval: Round & { action: string; edited?: boolean };
  /** `external`: integration runs against a backend the group did not start. */
  group_step: Round & { step: "build" | "integration" | "fix"; repo?: EventGroupRole; skipped?: string; failed?: string; external?: boolean };
  /** A member run's own event, wrapped; the backends route it to that repo's session. */
  group_child: { repo: string; role: EventGroupRole; event: OrchEvent };
  group_fault: { fault: EventGroupRole | "both"; goals: Partial<Record<EventGroupRole, string>>; cost: number; revised?: boolean };
  /** `parked`: where each member's work went (null: nothing to park); `kept`: members whose park failed. */
  group_end: {
    ok: boolean;
    reason?: string;
    parked?: Partial<Record<EventGroupRole, string | null>>;
    kept?: Partial<Record<EventGroupRole, string>>;
  };
  group_rollback: { group: string; parked: Partial<Record<EventGroupRole, string | null>> };
  /**
   * --branch / --pr, after a pass: a member's work on its group branch (its base never moved). `url`: the pull request
   * opened; `link`: pushed without one, the host's page to open it; `error`: the push or pull request failed.
   */
  group_branch: { role: EventGroupRole; repo: string; branch: string; base: string; url?: string; link?: string; pushed?: boolean; error?: string };
}

export type OrchEventType = keyof OrchEventData;
export type OrchEventOf<K extends OrchEventType> = { type: K; t: number } & OrchEventData[K];
/** Any event, narrowed by `type`. */
export type OrchEvent = { [K in OrchEventType]: OrchEventOf<K> }[OrchEventType];

/** Every event type; a type added to OrchEventData without an entry here fails the typecheck. */
const TYPES: { [K in OrchEventType]: true } = {
  goal_start: true,
  goal_end: true,
  checkpoint: true,
  resumed: true,
  goal_branch: true,
  pr: true,
  ci: true,
  usage_limit: true,
  waiting: true,
  usage: true,
  history_error: true,
  round_start: true,
  architect_start: true,
  plan: true,
  critic: true,
  approval_wait: true,
  approval: true,
  task_start: true,
  task_activity: true,
  task_end: true,
  unowned: true,
  protected: true,
  secrets: true,
  round_diff: true,
  checks_start: true,
  checks: true,
  review: true,
  visual_start: true,
  visual: true,
  round_end: true,
  stuck: true,
  question_wait: true,
  question_answered: true,
  command_wait: true,
  command_decided: true,
  queue_item: true,
  queue_changed: true,
  blocked: true,
  retry: true,
  intake: true,
  loop_stop: true,
  split_proposal: true,
  coverage: true,
  learn_start: true,
  learn_end: true,
  share_start: true,
  share_end: true,
  notes_tidy: true,
  group_start: true,
  group_plan: true,
  group_approval_wait: true,
  group_approval: true,
  group_step: true,
  group_child: true,
  group_fault: true,
  group_end: true,
  group_rollback: true,
  group_branch: true,
};
export const EVENT_TYPES = Object.keys(TYPES) as OrchEventType[];

/** Events whose `cost` the backends add to the daily budget (main.rs `on_event` keeps the same list). */
export const COST_EVENTS: ReadonlySet<string> = new Set<OrchEventType>([
  "plan",
  "task_end",
  "review",
  "learn_end",
  "notes_tidy",
  "share_end",
  "split_proposal",
  "coverage",
  "group_plan",
  "group_fault",
]);
