#!/usr/bin/env tsx
// YAAIORCH (Yet Another AI Orchestrator) CLI. Run from the target repo root. Usage: see USAGE below.
import { spawn, spawnSync, execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  rmSync,
  appendFileSync,
  openSync,
  closeSync,
  statSync,
  utimesSync,
  realpathSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, basename, dirname, resolve, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { BUILTIN_AGENTS } from "./orch-agents";
import { resolveClaude, resolveCommand, type ClaudeCmd } from "./claude-bin";
import {
  DevServer,
  MAX_TARGETS,
  browserLogin,
  captureVisual,
  findBrowser,
  hasWebSocket,
  installBrowser,
  isLocalUrl,
  parseServe,
  profileDir,
  validateTargets,
  visualReport,
  type ServeConfig,
  type VisualResult,
  type VisualTarget,
} from "./orch-browser";

const USAGE = `YAAIORCH (Yet Another AI Orchestrator) CLI. Run from the target repo root.
  orch run "<goal>"     one goal, loops architect -> build -> QA until QA passes
  orch add "<goal>"     queue a goal
  orch loop             process the queue continuously (Ctrl+C stops after current goal)
  orch status           show queue
  orch agents [--json]  list agents + skills the architect will see
  orch doctor [--json]  check node, claude (installed, logged in), git and the repo
  orch stop-after        a running loop stops before its next goal (the current one finishes)
  orch learn             study the repo (read-only) and write .orchestrator/brief.md for later goals
  orch split "<brief>" [--brief-file FILE] [--start]   split a big brief into queued goals for this repo (kept in
                        .orchestrator/spec.md, which every goal's architect reads); --start runs the loop right away;
                        --propose only shows the split; --accept queues {brief, goals} JSON from stdin
  orch new DIR "<spec>" [--spec-file FILE] [--setup CMD] [--start]   start a project in a new or empty folder: git,
                        SPEC.md, a .gitignore, and the spec split into queued goals (scaffold first) with suggested
                        checks in .orchestrator/config.json; --start runs the loop, else "orch loop --until-empty" there
  orch retry ID          put a failed or blocked goal back in the queue, with the goals it blocked
  orch intake [--github LABEL] [--backlog FILE]   queue open GitHub issues with that label (via gh) and the
                        unchecked "- [ ]" items of a backlog file, each once; anyone who can label issues
                        can direct the agents, so use a label only people you trust can set
  orch approve [--reject "WHY"] [--plan-stdin]   answer a run waiting with --approve-plan: build the plan (edited:
                        a plan as JSON on stdin), or send it back to the architect with your reason
  orch share [--dry-run]  propose what orch learned (brief and lasting notes) as a CLAUDE.md section, committed
                        on an orchestrator/claude-md-* branch for you to review and merge (--dry-run: print it)
  orch plugins [--json] [--details]  Claude Code plugins installed for this repo (--details: token cost)
  orch rollback [BRANCH]  reset to the latest (or given) checkpoint; discarded work is kept
                        on an orchestrator/discarded-* branch
  orch prune [--older-than DAYS]  delete orchestrator/* branches older than DAYS (14)
  orch browser [status | login [URL] | install]   the browser the checks use (status); log in to the app once in
                        a window on this repo's own browser profile, which the checks reuse (login); download
                        Chrome for Testing into ~/.yaaiorch/browser when no Chrome, Edge, Chromium or Brave is installed
Options: --max-rounds N (5)  --power max|heavy|balanced|economy (heavy)
         --max-cost USD (per goal, no limit by default)  --agent-timeout MINUTES (30)
         --poll SECONDS (15)  --until-empty  --dry-run (plan only; not with loop)
         --model architect=opus,impl=haiku,qa=sonnet,heavy=opus,dev=sonnet,<agent>=<model>
                  override the tier's model per role or per agent (aliases or full model IDs);
                  also "models" in .orchestrator/config.json. Aliases step up with the tier on escalation.
         --on-limit wait|stop   on a Claude usage limit: wait for the reset and retry (default), or stop
                  (exit code 3); also "onLimit" in .orchestrator/config.json
         --usage-cap 5h=80,week=90   pause (or, with --on-limit stop, stop) before an agent call once the
                  Claude subscription's 5-hour or weekly usage is at that percentage; also "usageCap" in config
         --plugins off   agents run without any Claude Code plugins  --disable-plugins ID,ID  without these
                  (ids from "orch plugins")  --no-hooks  without settings and plugin hooks; also "plugins"
                  in config: {"off": true, "disable": [...], "hooks": false}. Your Claude Code setup is unchanged.
         --critic   a read-only critic agent reviews each plan before building; a rejected plan goes back to
                  the architect once; also "critic": true in config
         --diff-critic   the critic also reviews each round's change against the goal, next to QA; a rejection
                  fails the round like a QA failure; also "diffCritic": true in config
         --review   a read-only reviewer checks each round's change for bugs and security problems; a rejection
                  fails the round  --reviewers A,B   use these agents (yours, from .claude/agents) instead of the
                  built-in reviewer; also "review": true or ["A", "B"] in config
         --no-notes   do not use or write .orchestrator/notes.md (lessons from earlier goals, read by the
                  architect); also "notes": false in config
         --strict-files   a file changed outside every task's file list fails the round (default: QA is told)
                  also "strictFiles": true in config
         --max-cost-total USD   loop only: stop before the next goal once the queue has spent this much
                  (each goal also gets at most what is left as its --max-cost); also "maxCostTotal" in config
         --no-brief   do not use or write .orchestrator/brief.md (the architect's notes on the repo,
                  reused across rounds and goals); also "brief": false in config
         --intake github:LABEL,backlog:FILE   loop: when the queue runs dry, pull new goals in (orch intake);
                  also "intake" in config
         --protect PATHS   comma-separated paths no task may change ("dir/", "file", "*.pem", "infra/**"); a plan
                  that lists one is sent back, and a change there anyway is reverted and fails the round; default
                  .github/workflows/; also "protect" in config ([] for none)
         --no-secret-scan   do not check the changes for keys, tokens, private keys and .env files before each commit
                  (by default a finding blocks the commit and fails the round); also "secretScan": false
         --ci-fixes N   with --pr: wait for the pull request's CI checks; when one fails, run up to N fix goals on
                  its branch (default 2; 0 only reports it)  --no-ci-watch   do not wait; also "ciFixes", "ciWatch"
         --no-issue-comments   loop: do not comment on the GitHub issue a goal came from (by default: when it starts,
                  is done, fails or is blocked); also "issueComments": false. Labels p1-p9 or priority: high|low
                  order the goals (p1 first)
         --retries N   loop: try a failed goal again N times (default 1), one power tier higher each time; after
                  that, goals that build on it are marked blocked ("orch retry ID" runs them again); also "retries"
         --no-coverage   when the queue runs dry after goals from a brief, do not check the brief against the code
                  and queue what is missing (at most twice per brief); also "coverage": false in config
         --approve-plan   after planning, wait until you approve the plan ("orch approve", or the UI), edit it or
                  send it back with a reason; also "approvePlan": true in config
         --branch   run each goal on its own branch, orch/<id>-<slug>, and switch back afterwards: your branch is
                  never changed (the goal's work stays on its branch); also "branch": true in config
         --pr   with --branch: when a goal passes, push its branch to origin and open a pull request with gh
                  (GitHub CLI) against your branch; also "pr": true in config
         --no-resume   fix rounds start every implementer cold (default: an agent that worked on the same
                  files in the round before continues its session); also "resume": false in config
         --fast   round 1 is one agent doing the whole goal, judged by the checks (QA only if there
                  are no checks); if that fails, later rounds run the full architect/build/QA loop
         --no-visual   no browser checks. They run when .orchestrator/config.json has "serve": {"url":
                  "http://localhost:5173", "command": "npm run dev"}: the architect names pages, orch starts the app
                  and opens them in Chrome or Edge after the checks, and QA gets screenshots and measurements (a page
                  that does not render fails the round); also "visual": false in config
Agents: built-in (architect, fe, be, qa), overridden by ~/.claude/agents and ./.claude/agents.
The architect and verifiers run read-only; implementers may edit.
Checks: after each build phase the orchestrator runs the repo's checks itself and a non-zero exit
fails the round. From .orchestrator/config.json {"checks": {"name": "command"}, "allow": ["Bash(...)"]},
else the package.json scripts typecheck, lint, test, build. Agents may run those commands too.
In a git repo the working tree must be clean. Each round's changes are committed on the current
branch on top of a checkpoint branch (orchestrator/checkpoint-*) that is deleted when QA passes.
A round that changes nothing or repeats the same failures moves one power tier up; two such
rounds in a row stop the goal.
When the Claude usage limit is hit, the goal's work is set aside and the goal is retried after the
reset time from the CLI's message (or, with --on-limit stop, the goal is left pending and orch exits 3).`;

const PHASES = ["foundation", "build", "verify"] as const;
type Phase = (typeof PHASES)[number];
/** `visual` (verify tasks only): pages orch opens in a browser before this task runs; see orch-browser.ts. */
type Task = { agent: string; phase: Phase; task: string; files?: string[]; heavy?: boolean; figma?: string; skills?: string[]; visual?: VisualTarget[] };
/** `brief`: the architect's project brief, when there was none yet or the old one was wrong. */
type Plan = { summary: string; tasks: Task[]; brief?: string };
type Verdict = { passed: boolean; failures: string[]; notes?: string[] };
/** The plan critic's answer. */
type Review = { approved: boolean; issues: string[] };
/** `note` says why a pending goal is waiting (for example a usage-limit reset). */
type Item = {
  id: number;
  goal: string;
  /** blocked: a goal it builds on failed; it waits for "orch retry" (of that goal, or of this one). */
  status: "pending" | "running" | "done" | "failed" | "blocked";
  note?: string;
  fromSpec?: boolean;
  /** Ids of the goals this one builds on: it runs only after they are done. */
  after?: number[];
  /** The brief it came from (a shared branch with --branch). */
  brief?: string;
  /** Times it was retried after failing, and the tier it runs at then. */
  attempts?: number;
  power?: Power;
  /** What its runs cost and how long they took, all attempts together (for the UI's progress). */
  cost?: number;
  seconds?: number;
  /** A usage limit cut it short: its work so far is on this branch, and the next attempt starts from it. */
  resumeFrom?: string;
  /** Where it came from (orch intake): a GitHub issue number, or a BACKLOG.md item's key. */
  issue?: number;
  backlog?: string;
  /** 1 (first) to 9 (last); 3 when not given. From a p1-p9 / priority label, or "(p1)" in a backlog item. */
  priority?: number;
};
type AgentSource = "builtin" | "user" | "project";
type Entry = { name: string; description: string; builtin?: boolean; source?: AgentSource; content?: string };
type TokenUsage = { input: number; output: number; cacheRead: number; cacheCreation: number };
type Result = {
  agent: string;
  out: string;
  touched: string[];
  cost: number;
  tokens?: TokenUsage;
  error?: string;
  fatal?: Error;
  status?: string;
  session?: string;
};

const POWER = {
  max: { arch: "opus", impl: "opus", heavy: "opus", qa: "opus" },
  heavy: { arch: "opus", impl: "sonnet", heavy: "opus", qa: "opus" },
  balanced: { arch: "sonnet", impl: "sonnet", heavy: "opus", qa: "opus" },
  economy: { arch: "sonnet", impl: "haiku", heavy: "sonnet", qa: "sonnet" },
} as const;
type Power = keyof typeof POWER;
/** Escalation order for stuck rounds. */
const TIERS: Power[] = ["economy", "balanced", "heavy", "max"];

// ---------- model selection: per-agent override > per-role override > power tier ----------
/** Roles that call a model. `dev` is the fast path's single agent; by default it uses the tier's heavy model. */
const ROLES = ["architect", "impl", "heavy", "qa", "dev"] as const;
type Role = (typeof ROLES)[number];
/** Overrides from --model and .orchestrator/config.json; anything unset comes from the power tier. */
type Models = { roles: Partial<Record<Role, string>>; agents: Record<string, string> };
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
/** Aliases move one step up this ladder when a stuck round escalates; full model IDs stay as set. */
const ALIAS_LADDER = ["haiku", "sonnet", "opus"];

function checkModel(name: string, where: string) {
  if (!MODEL_RE.test(name)) throw new Error(`${where}: invalid model name "${name}"`);
  return name;
}

/** "architect=opus,qa=sonnet,be=claude-opus-5-5": role keys set a role, any other key names an agent. */
function parseModelSpec(spec: string): Models {
  const m: Models = { roles: {}, agents: {} };
  for (const part of spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [key, value, ...rest] = part.split("=").map((s) => s.trim());
    if (!key || !value || rest.length) throw new Error(`--model: expected key=model, got "${part}"`);
    checkModel(value, "--model");
    if ((ROLES as readonly string[]).includes(key)) m.roles[key as Role] = value;
    else m.agents[key] = value;
  }
  return m;
}

/** Config overrides first, then the CLI on top. */
function mergeModels(cfg: Config["models"], cli: Models): Models {
  const roles: Partial<Record<Role, string>> = {};
  for (const r of ROLES) if (cfg?.[r]) roles[r] = checkModel(cfg[r]!, "config.json models");
  const agents: Record<string, string> = {};
  for (const [a, v] of Object.entries(cfg?.agents ?? {})) agents[a] = checkModel(v, "config.json models.agents");
  return { roles: { ...roles, ...cli.roles }, agents: { ...agents, ...cli.agents } };
}

function tierModel(power: Power, role: Role): string {
  const t = POWER[power];
  return role === "architect" ? t.arch : role === "dev" ? t.heavy : t[role];
}

function modelFor(power: Power, m: Models, role: Role, agent?: string): string {
  return (agent && m.agents[agent]) || m.roles[role] || tierModel(power, role);
}

const effectiveModels = (power: Power, m: Models) => Object.fromEntries(ROLES.map((r) => [r, modelFor(power, m, r)]));

function bumpAliases(m: Models): Models {
  const up = (v: string) => (ALIAS_LADDER.includes(v) ? ALIAS_LADDER[Math.min(ALIAS_LADDER.indexOf(v) + 1, ALIAS_LADDER.length - 1)] : v);
  return {
    roles: Object.fromEntries(Object.entries(m.roles).map(([k, v]) => [k, up(v!)])),
    agents: Object.fromEntries(Object.entries(m.agents).map(([k, v]) => [k, up(v)])),
  };
}

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
/** How claude is started, resolved once: no shell on Windows unless its .cmd shim cannot be read (see claude-bin.ts). */
let claudeCmd: ClaudeCmd | undefined;
const claudeBin = () => (claudeCmd ??= resolveClaude(CLAUDE));
const notFound = () => `"${CLAUDE}" not found on PATH; install Claude Code or set CLAUDE_BIN`;
function spawnClaude(args: string[], opts: SpawnOptions = {}) {
  const c = claudeBin();
  if (c.missing) throw new Error(notFound());
  return spawn(c.file, [...c.pre, ...args], { ...opts, shell: c.shell, windowsHide: true });
}
function claudeSync(args: string[]) {
  const c = claudeBin();
  if (c.missing) return { status: null, stdout: "", stderr: notFound() };
  return spawnSync(c.file, [...c.pre, ...args], { encoding: "utf8", shell: c.shell, windowsHide: true, timeout: 30_000 });
}
const DIR = ".orchestrator";
const QUEUE = join(DIR, "queue.json");
const LAST_RUN = join(DIR, "last-run.json");
// Relative, forward slashes, no spaces: safe even when claude has to go through cmd.exe.
const BUILTIN_FILE = `${DIR}/builtin-agents.json`;
/** The architect's notes on the repo (stack, layout, conventions, commands), reused by later rounds and goals. */
const BRIEF_FILE = join(DIR, "brief.md");
const MAX_BRIEF = 4000;
/** Lessons from earlier goals (QA's notes, what failed), read by the architect; oldest entries are dropped past MAX_NOTES. */
const NOTES_FILE = join(DIR, "notes.md");
const MAX_NOTES = 8000;
/** Past this size a cheap call merges and prunes the notes (tidyNotes) instead of only cutting the oldest. */
const TIDY_AT = 5000;
const NOTES_HEAD = "# Notes from earlier goals\n\n";
/** Implementers: allow-list for the check commands, run with acceptEdits. */
const AGENT_SETTINGS = `${DIR}/agent-settings.json`;
/** Architect and verifiers: same allow-list plus a deny on edit tools, run with permission mode "default". */
const READONLY_SETTINGS = `${DIR}/readonly-settings.json`;
const CONFIG_FILE = join(DIR, "config.json");
/** Held by the process that runs goals in this repo (run, loop, learn, rollback); see acquireRunLock(). */
const RUN_LOCK = join(DIR, "run.lock");
/** Present while the queue file is being edited; see updateQueue(). */
const QUEUE_LOCK = join(DIR, "queue.lock");
/** Created by `orch stop-after` or the UI: the loop exits before starting its next goal. */
const STOP_FILE = join(DIR, "stop-after-goal");
/** --approve-plan: the plan waiting for a human, and the answer `orch approve` writes. */
const PLAN_PENDING = join(DIR, "plan-pending.json");
const PLAN_DECISION = join(DIR, "plan-decision.json");
/** Browser checks: what the architect is told about them this goal ("" when off), and the app's dev server. */
let VISUAL_HINT = "";
let DEV_SERVER: DevServer | null = null;
const VISUAL_DIR = `${DIR}/visual`;
const MAX_TASKS = 25;
const MAX_FILES_PER_TASK = 60;

// ---------- state files: atomic writes and locks ----------
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Write through a temporary file and a rename, so a crash or a full disk never leaves half a file. On
 * Windows the rename can fail for a moment while another process reads the target: retry briefly.
 */
function writeFileAtomic(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes(code)) {
        try {
          unlinkSync(tmp);
        } catch {
          /* already gone */
        }
        throw e;
      }
      sleepSync(50);
    }
  }
}

/** True if a process with this id exists (EPERM: it exists but belongs to someone else). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

type LockInfo = { pid: number; host: string; cmd: string; since: number; id: string };
const LOCK_STALE_MS = 2 * 60_000;

/**
 * One goal-running orch per repo. The lock records who holds it; the holder touches it every 30 s. A
 * lock is taken over only when its process is gone (same machine) or it has not been touched for two
 * minutes (a reused process id, or another machine), so a live process never loses its lock. It is
 * released on exit, and only if it is still ours.
 */
function acquireRunLock(cmd: string) {
  mkdirSync(DIR, { recursive: true });
  const me: LockInfo = {
    pid: process.pid,
    host: hostname(),
    cmd,
    since: Date.now(),
    id: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const fd = openSync(RUN_LOCK, "wx");
      writeFileSync(fd, JSON.stringify(me));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 3) throw e;
      let holder: Partial<LockInfo> = {};
      let age: number;
      try {
        holder = JSON.parse(readFileSync(RUN_LOCK, "utf8"));
        age = Date.now() - statSync(RUN_LOCK).mtimeMs;
      } catch {
        age = Infinity; // unreadable or vanished: a crashed half-write
      }
      const sameHost = holder.host === hostname();
      const alive = age < LOCK_STALE_MS && (!sameHost || (typeof holder.pid === "number" && pidAlive(holder.pid)));
      if (alive)
        throw new Error(
          `another orch is already running in this repo (${holder.cmd ?? "?"}, pid ${holder.pid ?? "?"}${sameHost ? "" : ` on ${holder.host}`}, ` +
            `since ${holder.since ? new Date(holder.since).toLocaleString() : "?"}). Wait for it, stop it, or delete ${RUN_LOCK} if you are sure it is gone.`,
          { cause: e },
        );
      console.warn(
        `taking over a stale lock (${holder.cmd ?? "?"}, pid ${holder.pid ?? "?"}): ${sameHost ? "its process is gone" : "not touched for 2 minutes"}`,
      );
      try {
        unlinkSync(RUN_LOCK);
      } catch {
        /* someone else removed it first; try again */
      }
    }
  }
  const beat = setInterval(() => {
    try {
      utimesSync(RUN_LOCK, new Date(), new Date());
    } catch {
      /* lock removed by hand: nothing to touch */
    }
  }, 30_000);
  beat.unref();
  process.on("exit", () => {
    clearInterval(beat);
    try {
      if ((JSON.parse(readFileSync(RUN_LOCK, "utf8")) as LockInfo).id === me.id) unlinkSync(RUN_LOCK);
    } catch {
      /* not there, or not ours any more */
    }
  });
  // Ctrl+C and kill: exit normally so the lock is released (loop has its own SIGINT handler).
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.once(sig, () => process.exit(130));
  if (cmd !== "loop") process.once("SIGINT", () => process.exit(130));
}

/**
 * Edit the queue file under a short lock, so `orch add` (or the UI) and a running loop never overwrite
 * each other's changes. A queue lock older than 10 s belongs to a process that died mid-edit.
 */
function updateQueue<T>(edit: (q: Item[]) => T): T {
  mkdirSync(DIR, { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(QUEUE_LOCK, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(QUEUE_LOCK).mtimeMs > 10_000) unlinkSync(QUEUE_LOCK);
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) throw new Error(`the queue is locked (${QUEUE_LOCK}); try again`, { cause: e });
      sleepSync(50);
    }
  }
  try {
    const q = readQueue();
    const result = edit(q);
    writeFileAtomic(QUEUE, JSON.stringify(q, null, 2));
    return result;
  } finally {
    try {
      unlinkSync(QUEUE_LOCK);
    } catch {
      /* already removed */
    }
  }
}
const CHECK_SCRIPTS = ["typecheck", "lint", "test", "build"];
const CHECK_TIMEOUT_MS = 10 * 60_000;
/** Pathspec that keeps the orchestrator's own state out of status, diffs and commits. */
const NOT_STATE = ":(exclude).orchestrator";
const BRANCH_PREFIX = "orchestrator/";

// Output contracts, appended to every prompt so any agent (built-in or discovered) knows the format.
const PLAN_FORMAT = `

## Reply format
Reply with exactly one JSON object and nothing else:
{"summary": "<one line>", "tasks": [{"agent": "<name from the list>", "phase": "foundation" | "build" | "verify", "task": "<self-contained instructions>", "files": ["<path relative to the repo root>"], "heavy": false, "skills": []}]}
Every foundation and build task must list its files, no file may appear in two tasks, and there must be at least one verify task.
Add a "brief" field (a string) only when asked for one below.`;
const TASK_FORMAT = `

## Reply format
End your reply with exactly one of these lines: "Status: COMPLETE", "Status: PARTIAL" or "Status: FAILED".`;
const LEARN_FORMAT = `

## Reply format
Reply with exactly one JSON object and nothing else:
{"brief": "<markdown, at most 400 words: what the project is; stack and versions; layout (main folders and what lives where); conventions (naming, patterns, error handling, how tests are written); how to build, test and lint; pitfalls>"}`;
const REVIEW_FORMAT = `

## Reply format
Do not edit any file. Reply with exactly one JSON object and nothing else:
{"approved": true | false, "issues": ["<what is wrong with the plan and what it should do instead>"]}
Use an empty issues list when approved is true.`;
const TIDY_FORMAT = `

## Reply format
Do not edit any file. Reply with exactly one JSON object and nothing else:
{"notes": "<markdown bullet list, each lesson one line>"}`;
const SHARE_FORMAT = `

## Reply format
Do not edit any file. Reply with exactly one JSON object and nothing else:
{"section": "<markdown for the section's body: no top heading, at most 400 words>"}`;
const VERDICT_FORMAT = `

## Reply format
Do not edit any file. Reply with exactly one JSON object and nothing else:
{"passed": true | false, "failures": ["<what is wrong, where, and how to fix it>"], "notes": ["<optional>"]}
List only problems that need fixing: no notes, no "no defects found". Use an empty failures list when passed is true.
"notes" is for lessons a later goal in this repo should know (a pitfall, a decision, a convention you found), at most 3 short ones; usually leave it out.
The check results above were produced by the orchestrator; do not fail only because you could not re-run them yourself.`;

/** Structured events for UIs: one "@@ORCH@@ {json}" line per event, only when ORCH_EVENTS is set. */
const emit = (type: string, data: Record<string, unknown> = {}) => {
  if (process.env.ORCH_EVENTS) console.log("@@ORCH@@ " + JSON.stringify({ type, t: Date.now(), ...data }));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const usd = (n: number) => `$${n.toFixed(2)}`;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// ---------- discovery: built-in, then user-level (~/.claude), then project-level (./.claude) ----------
function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const frontmatter = (path: string) => parseFrontmatter(readFileSync(path, "utf8"));
const roots = () => [join(homedir(), ".claude"), join(process.cwd(), ".claude")];

function discoverAgents(): Entry[] {
  const found = new Map<string, Entry>();
  for (const [name, a] of Object.entries(BUILTIN_AGENTS))
    found.set(name, {
      name,
      description: a.description,
      builtin: true,
      source: "builtin",
      content: `---\nname: ${name}\ndescription: ${a.description}\n---\n\n${a.prompt}\n`,
    });
  for (const [rootIndex, r] of roots().entries()) {
    const d = join(r, "agents");
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".md"))) {
      const path = join(d, f);
      const content = readFileSync(path, "utf8");
      const fm = parseFrontmatter(content);
      const name = fm.name ?? basename(f, ".md");
      found.set(name, { name, description: (fm.description ?? "").slice(0, 160), source: rootIndex === 0 ? "user" : "project", content }); // later roots override earlier ones
    }
  }
  return [...found.values()];
}

function saveAgent(name: string, content: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
    throw new Error("agent name must start with a letter or number and contain only letters, numbers, dashes or underscores");
  if (content.length > 100_000) throw new Error("agent definition is too large (maximum 100 KB)");
  const fm = parseFrontmatter(content);
  if (fm.name !== name) throw new Error(`agent frontmatter name must be "${name}"`);
  if (!fm.description?.trim()) throw new Error("agent description is required in the frontmatter");
  const body = /^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(content)?.[1];
  if (!body?.trim()) throw new Error("agent instructions are required after the frontmatter");
  const path = join(process.cwd(), ".claude", "agents", `${name}.md`);
  writeFileAtomic(path, `${content.trimEnd()}\n`);
  return path;
}

/** Write the built-in agents still in use to the file passed to `claude --agents`. */
function writeBuiltins(roster: Entry[]) {
  const defs = Object.fromEntries(roster.filter((a) => a.source === "builtin").map((a) => [a.name, BUILTIN_AGENTS[a.name]]));
  mkdirSync(DIR, { recursive: true });
  writeFileSync(BUILTIN_FILE, JSON.stringify(defs, null, 2));
}

function discoverSkills(): Entry[] {
  const found = new Map<string, Entry>();
  for (const [rootIndex, r] of roots().entries()) {
    const d = join(r, "skills");
    if (!existsSync(d)) continue;
    for (const s of readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const p = join(d, s.name, "SKILL.md");
      if (!existsSync(p)) continue;
      const fm = frontmatter(p);
      const name = fm.name ?? s.name;
      found.set(name, { name, description: (fm.description ?? "").slice(0, 120), source: rootIndex === 0 ? "user" : "project" });
    }
  }
  return [...found.values()];
}

// ---------- checks: run by the orchestrator, because headless agents may not get shell access ----------
type Config = {
  checks?: Record<string, string>;
  allow?: string[];
  models?: Partial<Record<Role, string>> & { agents?: Record<string, string> };
  onLimit?: "wait" | "stop";
  usageCap?: { "5h"?: number; week?: number };
  plugins?: { off?: boolean; disable?: string[]; hooks?: boolean };
  brief?: boolean;
  strictFiles?: boolean;
  maxCostTotal?: number;
  notes?: boolean;
  critic?: boolean;
  resume?: boolean;
  diffCritic?: boolean;
  review?: boolean | string[];
  branch?: boolean;
  pr?: boolean;
  approvePlan?: boolean;
  coverage?: boolean;
  retries?: number;
  /** loop --intake: "github:LABEL" and/or "backlog:FILE". */
  intake?: string | string[];
  /** Paths no task may change ("dir/", "file", "*.lock", "infra/**"); default [".github/workflows/"]. */
  protect?: string[];
  secretScan?: boolean;
  issueComments?: boolean;
  /** --pr: fix goals for failing CI checks (default 2; 0 only reports them); ciWatch false: do not wait for CI. */
  ciFixes?: number;
  ciWatch?: boolean;
  /** Installs dependencies (for example "npm install"), run by orch before the checks when a manifest changed. */
  setup?: string;
  /** Files whose change triggers `setup` (default: the usual manifests and lock files). */
  setupWhen?: string[];
  /** Browser checks: how to start the app (a localhost url, and the command that serves it unless it already runs). */
  serve?: ServeConfig;
  /** false: no browser checks even with "serve". */
  visual?: boolean;
};
type Check = { name: string; command: string; ok: boolean; code: number | null; output: string; ms: number };

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch (e) {
    throw new Error(`cannot parse ${path}: ${msg(e)}`, { cause: e });
  }
}

/** Checks from .orchestrator/config.json, else the usual package.json scripts (skipping npm's placeholder test). */
function loadChecks(cfg: Config): Record<string, string> {
  if (cfg.checks) return cfg.checks;
  const scripts = readJsonFile<{ scripts?: Record<string, string> }>("package.json", {}).scripts ?? {};
  return Object.fromEntries(CHECK_SCRIPTS.filter((s) => scripts[s] && !/no test specified/.test(scripts[s])).map((s) => [s, `npm run ${s}`]));
}

/**
 * Let agents run the checks and read-only git. Compound commands (cd && ...) still need approval, so
 * they may not. Read-only roles also deny the edit tools and run in permission mode "default", where
 * shell commands that write files are refused too (acceptEdits would let `echo > file` through).
 */
function writeAgentSettings(cfg: Config, checks: Record<string, string>, plugins: PluginChoice) {
  const cmds = [...Object.values(checks), ...(checks.test ? ["npm test"] : []), "git status", "git diff", "git log", "git show"];
  const allow = [...cmds.flatMap((c) => [`Bash(${c}:*)`, `PowerShell(${c}:*)`]), ...(cfg.allow ?? [])];
  const extra = pluginSettings(plugins);
  writeFileSync(AGENT_SETTINGS, JSON.stringify({ permissions: { allow }, ...extra }, null, 2));
  writeFileSync(READONLY_SETTINGS, JSON.stringify({ permissions: { allow, deny: ["Edit", "Write", "MultiEdit", "NotebookEdit"] }, ...extra }, null, 2));
}

// ---------- plugins: which of the user's Claude Code plugins and hooks the agents get ----------
/** `off`: no plugins at all; `disable`: these plugin ids off; `hooks: false`: no settings or plugin hooks. */
type PluginChoice = { off: boolean; disable: string[]; hooks: boolean };
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
type Plugin = { id: string; name: string; scope: string; enabled: boolean; tokens?: number };

/** `claude plugin list --json`, run in the repo so project-scoped plugins are included. */
function listPlugins(): Plugin[] {
  const r = claudeSync(["plugin", "list", "--json"]);
  if (r.status !== 0) throw new Error(`"claude plugin list --json" failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
  const raw = JSON.parse(r.stdout) as { id?: string; scope?: string; enabled?: boolean; projectEnabled?: boolean }[];
  return raw
    .filter((p) => typeof p.id === "string" && PLUGIN_ID_RE.test(p.id))
    .map((p) => ({ id: p.id!, name: p.id!.split("@")[0], scope: p.scope ?? "user", enabled: p.enabled !== false || p.projectEnabled === true }));
}

/** "Always-on: ~1,266 tok" from `claude plugin details <id>`, run for all plugins at once. */
async function pluginTokens(plugins: Plugin[]): Promise<void> {
  await Promise.all(
    plugins.map(
      (p) =>
        new Promise<void>((resolve) => {
          const c = spawnClaude(["plugin", "details", p.id]);
          let out = "";
          c.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
          const timer = setTimeout(() => killTree(c), 30_000);
          c.on("close", () => {
            clearTimeout(timer);
            const m = /Always-on:\s*~?([\d,]+)\s*tok/i.exec(out);
            if (m) p.tokens = Number(m[1].replace(/,/g, ""));
            resolve();
          });
          c.on("error", () => (clearTimeout(timer), resolve()));
        }),
    ),
  );
}

/** Settings for the agents' --settings file: plugins switched off and/or hooks disabled. */
function pluginSettings(c: PluginChoice): { enabledPlugins?: Record<string, false>; disableAllHooks?: true } {
  const ids = c.off
    ? listPlugins()
        .filter((p) => p.enabled)
        .map((p) => p.id)
    : c.disable;
  return {
    ...(ids.length ? { enabledPlugins: Object.fromEntries(ids.map((id) => [id, false as const])) } : {}),
    ...(c.hooks ? {} : { disableAllHooks: true as const }),
  };
}

function parsePlugins(values: Record<string, string | boolean | undefined>, cfg: Config["plugins"]): PluginChoice {
  const mode = String(values.plugins ?? (cfg?.off ? "off" : "on"));
  if (mode !== "on" && mode !== "off") throw new Error(`--plugins must be on or off, got "${mode}"`);
  const fromCli =
    typeof values["disable-plugins"] === "string"
      ? values["disable-plugins"]
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  const disable = [...new Set([...(cfg?.disable ?? []), ...fromCli])];
  for (const id of disable)
    if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) throw new Error(`--disable-plugins: invalid plugin id "${id}" (see "orch plugins")`);
  return { off: mode === "off", disable, hooks: !values["no-hooks"] && cfg?.hooks !== false };
}

function runChecks(checks: Record<string, string>): Check[] {
  return Object.entries(checks).map(([name, command]) => {
    const start = Date.now();
    const r = spawnSync(command, { shell: true, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`.trim();
    const c: Check = { name, command, ok: r.status === 0, code: r.status, output: output.slice(-4000), ms: Date.now() - start };
    console.log(`check ${name} (${command}): ${c.ok ? "passed" : `FAILED (exit ${c.code})`}`);
    return c;
  });
}

const checkReport = (cs: Check[]) =>
  cs.length
    ? `\n\nChecks run by the orchestrator (trust these over the reports):\n` +
      cs.map((c) => `### ${c.name}: \`${c.command}\` ${c.ok ? "passed" : `FAILED (exit ${c.code})`}\n${c.output.slice(-1500) || "(no output)"}`).join("\n")
    : "\n\nNo checks are configured for this repo; verify by reading the code.";

// ---------- setup: orch installs dependencies (agents never do) when a manifest changed ----------
const MANIFESTS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
];
const SETUP_STATE = join(DIR, "setup-state.json");

/** A hash of the watched files' contents (missing ones count too), to tell when setup must run again. */
function manifestKey(files: string[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0${existsSync(f) ? readFileSync(f) : "-"}\0`);
  return h.digest("hex");
}

/** Untracked, not ignored directories at any depth ("node_modules/", "pkg/.venv/"), as git status shows them. */
function untrackedDirs(): string[] {
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".", NOT_STATE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return raw
    .split("\0")
    .filter((e) => e.startsWith("?? ") && e.endsWith("/"))
    .map((e) => e.slice(3));
}

/**
 * Run the config's `setup` command when the watched files changed since it last succeeded (or it never ran and one
 * of them exists). Directories it creates that git does not ignore yet (node_modules/, .venv/) go into
 * .git/info/exclude, so they are never committed; new files (a lock file) are left for the round commit.
 * Returns a Check named "setup", or null when nothing had to run.
 */
function runSetup(cfg: Config, git_: boolean): Check | null {
  if (!cfg.setup) return null;
  const watch = cfg.setupWhen?.length ? cfg.setupWhen : MANIFESTS;
  if (!watch.some((f) => existsSync(f))) return null;
  const before = manifestKey(watch);
  if (readJsonFile<{ key?: string }>(SETUP_STATE, {}).key === before) return null;
  const dirsBefore = git_ ? new Set(untrackedDirs()) : new Set<string>();
  const [c] = runChecks({ setup: cfg.setup });
  if (c.ok) writeFileAtomic(SETUP_STATE, JSON.stringify({ key: manifestKey(watch), at: new Date().toISOString() }));
  if (git_) {
    const added = untrackedDirs().filter((d) => !dirsBefore.has(d));
    if (added.length) {
      const exclude = git("rev-parse", "--git-path", "info/exclude");
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, `\n# added by orch setup (${cfg.setup})\n${added.map((d) => `/${d}`).join("\n")}\n`);
      console.log(`setup created ${added.join(", ")}; kept out of git via ${exclude}`);
    }
  }
  return c;
}

// ---------- claude runner (prompt via stdin: no quoting problems on Windows) ----------
type CliResult = {
  result?: unknown;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  session_id?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
  message?: { usage?: unknown };
  tokens?: TokenUsage;
};

function tokenUsageFrom(raw: unknown, camelCase = false): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const get = (snake: string, camel: string) => {
    const n = u[camelCase ? camel : snake];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
  };
  const input = get("input_tokens", "inputTokens");
  const output = get("output_tokens", "outputTokens");
  const cacheRead = get("cache_read_input_tokens", "cacheReadInputTokens");
  const cacheCreation = get("cache_creation_input_tokens", "cacheCreationInputTokens");
  if ([input, output, cacheRead, cacheCreation].every((n) => n === undefined)) return undefined;
  return {
    input: (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0),
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheCreation: cacheCreation ?? 0,
  };
}

function addTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

function tokenUsageDelta(after?: TokenUsage, before?: TokenUsage): TokenUsage | undefined {
  if (!after) return undefined;
  return {
    input: after.input - (before?.input ?? 0),
    output: after.output - (before?.output ?? 0),
    cacheRead: after.cacheRead - (before?.cacheRead ?? 0),
    cacheCreation: after.cacheCreation - (before?.cacheCreation ?? 0),
  };
}

function tokensFromResult(r: CliResult): TokenUsage | undefined {
  const usage = tokenUsageFrom(r.usage);
  if (usage) return usage;
  if (!r.modelUsage || typeof r.modelUsage !== "object") return undefined;
  return Object.values(r.modelUsage as Record<string, unknown>).reduce<TokenUsage | undefined>(
    (total, model) => addTokenUsage(total, tokenUsageFrom(model, true)),
    undefined,
  );
}

/**
 * Money spent on one goal; `cap` is the --max-cost limit. Each agent call reserves its share of what is
 * left before it starts (`reserved`), so parallel calls cannot overspend together; `launching` counts the
 * calls of a parallel batch that have not started yet, so they get equal shares.
 */
type Budget = { spent: number; cap?: number; reserved: number; launching: number; tokens?: TokenUsage };

/**
 * Reserve this call's spending ceiling: an equal share of the unreserved budget among the calls still to
 * start in its batch. With too little unreserved but other calls running, wait for them to release theirs.
 * Returns undefined without a cap.
 */
async function reserve(budget: Budget): Promise<number | undefined> {
  if (budget.cap === undefined) return undefined;
  const share = Math.max(1, budget.launching);
  if (budget.launching > 0) budget.launching--;
  for (;;) {
    const free = budget.cap - budget.spent - budget.reserved;
    const mine = free / share;
    if (mine >= 0.01) {
      budget.reserved += mine;
      return mine;
    }
    if (budget.reserved <= 0) throw new BudgetExceeded(`budget of ${usd(budget.cap)} used up (${usd(budget.spent)} spent)`);
    await sleep(200);
  }
}
/** Percent caps on the subscription's usage windows (1-100); unset = no cap. */
type UsageCap = { fiveHour?: number; week?: number };
/** `repoContext`: the brief and recent lessons, put in front of every implementer and QA prompt. */
type RunCtx = { budget: Budget; timeoutMs: number; usageCap: UsageCap; onLimit: "wait" | "stop"; repoContext?: string; resume?: boolean };

// ---------- subscription usage: read from the CLI's rate_limit_event (stream-json) ----------
type Window = "fiveHour" | "week";
const WINDOWS: Record<Window, { key: string; label: string; cli: string }> = {
  fiveHour: { key: "five_hour", label: "5-hour", cli: "5h" },
  week: { key: "seven_day", label: "weekly", cli: "week" },
};
/** Latest reading per window: percent used and when the window resets (epoch ms). */
const usage: Partial<Record<Window, { pct: number; resetsAt: number }>> = {};

/** Fold one rate_limit_event into `usage`; true if a reading changed. API-key logins send none. */
function readUsage(ev: { rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }> } }): boolean {
  const w = ev.rate_limit_info?.unifiedWindows;
  if (!w) return false;
  let changed = false;
  for (const [name, { key }] of Object.entries(WINDOWS) as [Window, (typeof WINDOWS)[Window]][]) {
    const u = w[key];
    if (typeof u?.utilization !== "number" || typeof u.resetsAt !== "number") continue;
    const next = { pct: Math.round(u.utilization * 1000) / 10, resetsAt: u.resetsAt * 1000 };
    if (usage[name]?.pct !== next.pct || usage[name]?.resetsAt !== next.resetsAt) changed = true;
    usage[name] = next;
  }
  return changed;
}

/** "5h=80,week=90" -> caps in percent. */
function parseUsageCap(spec: string, cfg: Config["usageCap"]): UsageCap {
  const cap: UsageCap = {};
  const set = (key: string, value: unknown, where: string) => {
    const w = (Object.keys(WINDOWS) as Window[]).find((k) => WINDOWS[k].cli === key);
    if (!w) throw new Error(`${where}: unknown window "${key}" (use 5h or week)`);
    const n = Number(value);
    if (!(n > 0 && n <= 100)) throw new Error(`${where}: ${key} must be a percentage from 1 to 100, got "${value}"`);
    cap[w] = n;
  };
  for (const [k, v] of Object.entries(cfg ?? {})) set(k, v, "config.json usageCap");
  for (const part of spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [k, v, ...rest] = part.split("=").map((x) => x.trim());
    if (!k || !v || rest.length) throw new Error(`--usage-cap: expected 5h=PERCENT or week=PERCENT, got "${part}"`);
    set(k, v, "--usage-cap");
  }
  return cap;
}

/** The first window whose reading is at or over its cap and has not reset yet. */
function overCap(cap: UsageCap): { window: Window; pct: number; resetsAt: number } | null {
  for (const window of Object.keys(WINDOWS) as Window[]) {
    const u = usage[window],
      c = cap[window];
    if (u && c !== undefined && u.pct >= c && u.resetsAt > Date.now()) return { window, ...u };
  }
  return null;
}

let capWait: Promise<void> | null = null;
/**
 * Before each agent call: with a reading over a cap, stop (--on-limit stop) or wait in place until that
 * window resets. Parallel tasks share one wait. Nothing is set aside: the goal simply pauses.
 */
async function respectUsageCap(ctx: RunCtx) {
  for (let o = overCap(ctx.usageCap); o; o = overCap(ctx.usageCap)) {
    const what = `${WINDOWS[o.window].label} usage at ${o.pct}% (cap ${ctx.usageCap[o.window]}%)`;
    if (ctx.onLimit === "stop") throw new UsageLimit(`${what}; resets ${when(o.resetsAt)}`, o.resetsAt);
    if (!capWait) {
      const { window, resetsAt } = o;
      const until = waitUntil(resetsAt);
      console.log(`${what}; pausing until ${when(until)}.`);
      emit("waiting", { reason: "usage_cap", window, until });
      capWait = (async () => {
        while (Date.now() < until) await sleep(Math.min(5000, until - Date.now()));
        delete usage[window]; // the window has reset: the next call brings a fresh reading
        capWait = null;
      })();
    }
    await capWait;
  }
}
/** Ends the goal instead of becoming a task failure. */
class BudgetExceeded extends Error {}

/**
 * The Claude subscription's usage limit ("You've hit your 5-hour limit · resets 1:30am (Europe/London)").
 * The CLI reports it as an error result with subtype "success". It ends the goal: retrying before the reset
 * only fails again, and counting it as a task failure would trigger stuck detection for nothing.
 */
class UsageLimit extends Error {
  resetAt?: number;
  constructor(message: string, resetAt?: number) {
    super(message);
    this.resetAt = resetAt;
  }
}
const LIMIT_RE = /\b(?:hit|reached) your [^\n.]{0,40}?limit\b/i;
/** Fatal errors end the whole goal; anything else is a task failure for the next round. */
const isFatal = (e: unknown): e is BudgetExceeded | UsageLimit => e instanceof BudgetExceeded || e instanceof UsageLimit;

/** Wall-clock time h:mm in an IANA zone, as epoch ms, today or tomorrow (whichever is next). */
function nextWallTime(h: number, min: number, zone: string | undefined, now = Date.now()): number {
  let offset = (_t: number) => -new Date(_t).getTimezoneOffset() * 60_000; // local zone
  if (zone) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      offset = (t: number) => {
        const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
        return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
      };
    } catch {
      /* unknown zone: use the local one */
    }
  }
  const off = offset(now);
  const wall = new Date(now + off); // UTC fields of this are the wall time in the zone
  let target = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), h, min) - off;
  if (target <= now) target += 86_400_000;
  return target;
}

/** "resets 1:30am (Europe/London)", "resets 14:00" -> epoch ms; undefined if there is no time in the text. */
function parseReset(text: string): number | undefined {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  if (h > 23 || min > 59) return undefined;
  return nextWallTime(h, min, m[4]?.trim());
}

function usageLimit(text: string): UsageLimit | null {
  if (!LIMIT_RE.test(text)) return null;
  return new UsageLimit(`Claude usage limit reached: ${text.trim().slice(0, 160)}`, parseReset(text));
}
const when = (t?: number) => (t ? new Date(t).toLocaleString() : "unknown");

/** Kill a child and everything it started (claude runs under a shell on Windows). */
function killTree(p: ChildProcess) {
  if (!p.pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * API overload, server errors and dropped connections, as the CLI reports them. Matched against the CLI's
 * own error text only (not task output), and never the usage limit, the budget or our agent timeout.
 */
const TRANSIENT_RE =
  /API Error: (?:5\d\d|429)\b|overloaded_error|\bapi_error\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|Connection error|Request timed out/i;

type Reply = { text: string; cost: number; tokens?: TokenUsage; session?: string };

/** `resume`: a session id to continue (forked, so the original stays as it was). */
async function run(agent: Entry, model: string, prompt: string, ctx: RunCtx, readOnly: boolean, resume?: string): Promise<Reply> {
  for (let attempt = 1; ; attempt++) {
    await respectUsageCap(ctx);
    try {
      return await runOnce(agent, model, prompt, ctx, readOnly, resume);
    } catch (e) {
      const text = msg(e);
      if (attempt >= 2 || isFatal(e) || /timed out after \d/.test(text) || !TRANSIENT_RE.test(text)) throw e;
      const wait = Number(process.env.ORCH_RETRY_DELAY_MS ?? 15_000);
      console.warn(`${agent.name}: transient error (${text.slice(0, 160)}); retrying once in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
}

/** The CLI's stream-json output: the final `result` line, plus any rate-limit readings. A single JSON object also works. */
function parseCliOutput(out: string): CliResult | undefined {
  let r: CliResult | undefined;
  let changed = false;
  let messageTokens: TokenUsage | undefined;
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (j?.type === "rate_limit_event") changed = readUsage(j) || changed;
      else if (j?.type === "assistant") messageTokens = addTokenUsage(messageTokens, tokenUsageFrom(j.message?.usage));
      else if (j?.type === "result" || (j && "total_cost_usd" in j)) r = j;
    } catch {
      /* not a JSON line */
    }
  }
  if (changed) emit("usage", { ...usage });
  if (r) r.tokens = tokensFromResult(r) ?? messageTokens;
  return r;
}

async function runOnce(agent: Entry, model: string, prompt: string, ctx: RunCtx, readOnly: boolean, resume?: string): Promise<Reply> {
  const { budget } = ctx;
  if (budget.cap !== undefined && budget.spent >= budget.cap) throw new BudgetExceeded(`budget of ${usd(budget.cap)} used up (${usd(budget.spent)} spent)`);
  const ceiling = await reserve(budget);
  let released = false;
  /** Give the reservation back and count what the call cost (once, however the call ends). */
  const settle = (cost: number, tokens?: TokenUsage) => {
    if (released) return;
    released = true;
    if (ceiling !== undefined) budget.reserved = Math.max(0, budget.reserved - ceiling);
    budget.spent += cost;
    budget.tokens = addTokenUsage(budget.tokens, tokens);
  };
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      ...(agent.builtin ? ["--agents", BUILTIN_FILE] : []),
      ...(existsSync(AGENT_SETTINGS) ? ["--settings", readOnly ? READONLY_SETTINGS : AGENT_SETTINGS] : []),
      "--agent",
      agent.name,
      "--model",
      model,
      // stream-json (needs --verbose) also carries rate_limit_event lines with the subscription's usage.
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      readOnly ? "default" : "acceptEdits",
      // --fork-session: the resumed call gets a new id, so retries and parallel tasks never share one.
      ...(resume ? ["--resume", resume, "--fork-session"] : []),
      // This call's reserved share. The CLI checks it after each turn, so a call can overshoot it a little.
      ...(ceiling !== undefined ? ["--max-budget-usd", (Math.floor(ceiling * 100 + 1e-6) / 100).toFixed(2)] : []),
    ];
    let p: ChildProcess & { stdout: NonNullable<ChildProcess["stdout"]>; stdin: NonNullable<ChildProcess["stdin"]> };
    try {
      p = spawnClaude(args, { stdio: ["pipe", "pipe", "inherit"] }) as typeof p;
    } catch (e) {
      settle(0);
      return reject(e);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p);
    }, ctx.timeoutMs);
    p.stdout.setEncoding("utf8"); // decode across chunk boundaries
    let out = "";
    p.stdout.on("data", (d: string) => (out += d));
    p.on("error", (e) => (clearTimeout(timer), settle(0), reject(e)));
    p.on("close", (code) => {
      clearTimeout(timer);
      const r = parseCliOutput(out);
      // Count the cost even when the call failed: the money is spent either way.
      const cost = typeof r?.total_cost_usd === "number" ? r.total_cost_usd : 0;
      settle(cost, r?.tokens);
      if (timedOut) {
        const limit = ctx.timeoutMs >= 60_000 ? `${Math.round(ctx.timeoutMs / 60_000)} min` : `${Math.round(ctx.timeoutMs / 1000)} s`;
        return reject(new Error(`${agent.name} timed out after ${limit}`));
      }
      if (r?.subtype === "error_max_budget_usd") return reject(new BudgetExceeded(`budget of ${usd(budget.cap ?? 0)} used up (${usd(budget.spent)} spent)`));
      const failed = !r || r.is_error || code !== 0;
      const limit = failed && usageLimit(typeof r?.result === "string" ? r.result : out.slice(0, 2000));
      if (limit) return reject(limit);
      if (!r) return reject(new Error(code !== 0 ? `${agent.name} exited ${code}` : `${agent.name}: unparsable CLI output: ${out.slice(0, 200)}`));
      if (r.is_error || code !== 0 || typeof r.result !== "string") {
        const detail = typeof r.result === "string" ? `: ${r.result.slice(0, 200)}` : "";
        return reject(new Error(`${agent.name}: CLI returned ${r.subtype ?? `exit ${code}`}${detail}`));
      }
      resolve({ text: r.result, cost, tokens: r.tokens, session: typeof r.session_id === "string" ? r.session_id : undefined });
    });
    p.stdin.end(prompt);
  });
}

/** Parse the JSON object in a reply: a fenced json block if present, else the outermost {...}. */
function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(text)?.[1];
  for (const c of [fenced, text]) {
    if (!c) continue;
    const s = c.indexOf("{"),
      e = c.lastIndexOf("}");
    if (s < 0 || e < s) continue;
    try {
      return JSON.parse(c.slice(s, e + 1)) as T;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`no valid JSON in reply: ${text.slice(0, 200)}`);
}

/** Compare paths the way the file system does: ./a, a\b and A/B (on Windows) are the same file. */
const normPath = (f: string) => {
  const p = f
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "");
  return process.platform === "win32" ? p.toLowerCase() : p;
};

/**
 * Why a planned file path is not acceptable, or null. Plans come from a model: a path must stay inside the
 * repo (no absolute, drive or UNC paths, no `..`, no symlink out of it) and away from .git and .orchestrator.
 */
function badPath(f: string): string | null {
  const p = f.trim();
  if (!p) return "is empty";
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\u0000-\u001f]/.test(p)) return "contains control characters";
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || /^[\\/]/.test(p) || p.startsWith("~")) return "must be a path relative to the repo root";
  const parts = p
    .replace(/\\/g, "/")
    .split("/")
    .filter((x) => x && x !== ".");
  if (parts.includes("..")) return "must not leave the repo (..)";
  const first = parts[0]?.toLowerCase();
  if (first === ".git" || first === DIR) return `is inside ${first}/, which agents must not touch`;
  // A symlinked folder could still point outside: resolve the deepest part that exists.
  try {
    const root = realpathSync(process.cwd());
    let probe = resolve(root, ...parts);
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const rel = relative(root, realpathSync(probe));
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel))
      return "resolves outside the repo (through a link)";
  } catch {
    /* unreadable path: the agent will fail on it anyway */
  }
  return null;
}

// ---------- protected paths and the secret scan ----------
/** Paths no task may change (config "protect", --protect); set for the goal being run. */
let PROTECT: string[] = [".github/workflows/"];

/** A protect pattern as a regex: "dir/" (or "dir") covers everything under it, * is one path segment, ** any depth. */
function protectRe(pattern: string): RegExp {
  const p = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const dir = p.endsWith("/");
  const body = p
    .replace(/\/+$/, "")
    .split("**")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]"),
    )
    .join(".*");
  return new RegExp(`^${body}${dir ? "/.*" : "(/.*)?"}$`, process.platform === "win32" ? "i" : "");
}

/** The protect pattern a path falls under, if any. */
function protectedBy(f: string, patterns = PROTECT): string | undefined {
  const p = f.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.find((pat) => protectRe(pat).test(p));
}

/** Put protected paths back as they were at HEAD (a new file is removed). */
function revertPaths(files: string[]) {
  for (const f of files) {
    try {
      git("cat-file", "-e", `HEAD:${f.replace(/\\/g, "/")}`);
      git("checkout", "-q", "HEAD", "--", f);
    } catch {
      rmSync(f, { force: true, recursive: true });
    }
  }
}

/** Known key and token formats (never logged, only named), and files that hold secrets by convention. */
const SECRETS: [string, RegExp][] = [
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI API key", /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["a private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
];
const ENV_FILE = /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i;
let SECRET_SCAN = true;

/** Never put recognized secret values in structured output or persisted UI summaries. */
function redactOutput(text: string): string {
  let safe = text.replace(
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----|$)/g,
    "[private key redacted]",
  );
  for (const [, re] of SECRETS) safe = safe.replace(new RegExp(re.source, `${re.flags}g`), "[secret redacted]");
  return safe;
}

function taskReport(text: string) {
  const safe = redactOutput(text);
  return { report: safe.slice(0, 4000), ...(safe.length > 4000 ? { reportTruncated: true } : {}) };
}

/**
 * Secrets in what is about to be committed: the lines added since HEAD in tracked files, all of each new file, and
 * any .env file. Returns where and what (the value itself is never returned or logged).
 */
function scanSecrets(): { file: string; what: string }[] {
  if (!SECRET_SCAN) return [];
  const out: { file: string; what: string }[] = [];
  const check = (file: string, text: string) => {
    for (const [what, re] of SECRETS) if (re.test(text)) out.push({ file, what });
  };
  // Before the first commit there is no HEAD: compare with git's empty tree, so everything counts as added.
  const base = hasCommits() ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const diff = execFileSync("git", ["diff", base, "--unified=0", "--no-color", "--no-ext-diff", "--", ".", NOT_STATE], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let file = "";
  let added: string[] = [];
  const flush = () => {
    if (file && added.length) check(file, added.join("\n"));
    added = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      flush();
      file = line.slice(4).replace(/^b\//, "");
    } else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  flush();
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", ".", NOT_STATE).split("\n").filter(Boolean);
  for (const f of untracked) {
    try {
      if (statSync(f).size > 2 * 1024 * 1024) continue;
      const text = readFileSync(f, "utf8");
      if (!text.includes("\u0000")) check(f, text);
    } catch {
      /* gone or unreadable */
    }
  }
  for (const f of [...untracked, ...changedFiles()])
    if (ENV_FILE.test(f.replace(/\\/g, "/")) && !out.some((x) => x.file === f)) out.push({ file: f, what: "an .env file" });
  return out;
}

function validate(plan: Plan, roster: Entry[]) {
  if (!plan || typeof plan.summary !== "string" || !Array.isArray(plan.tasks) || !plan.tasks.length)
    throw new Error('plan must be {"summary": string, "tasks": [...]} with at least one task');
  if (plan.tasks.length > MAX_TASKS) throw new Error(`plan has ${plan.tasks.length} tasks; at most ${MAX_TASKS}`);
  const names = new Set(roster.map((a) => a.name));
  const owner = new Map<string, string>();
  plan.tasks.forEach((t, i) => {
    if (!t || typeof t.task !== "string" || !t.task.trim()) throw new Error(`task ${i} has no task text`);
    if (!names.has(t.agent)) throw new Error(`task ${i} uses unknown agent "${t.agent}"`);
    if (!(PHASES as readonly string[]).includes(t.phase)) throw new Error(`task ${i} has invalid phase "${t.phase}"`);
    if (t.files !== undefined && !(Array.isArray(t.files) && t.files.every((f) => typeof f === "string")))
      throw new Error(`task ${i}: files must be a list of paths`);
    if (t.phase !== "verify" && !t.files?.length) throw new Error(`${t.phase} task ${i} (${t.agent}) lists no files`);
    if ((t.files?.length ?? 0) > MAX_FILES_PER_TASK) throw new Error(`task ${i} (${t.agent}) lists ${t.files!.length} files; at most ${MAX_FILES_PER_TASK}`);
    if (t.visual !== undefined) {
      if (t.phase !== "verify") throw new Error(`task ${i} (${t.agent}): only verify tasks may have "visual"`);
      t.visual = validateTargets(t.visual, `task ${i} (${t.agent})`);
    }
    for (const f of t.files ?? []) {
      const why = badPath(f);
      if (why) throw new Error(`task ${i} (${t.agent}): file "${f}" ${why}`);
      const prot = protectedBy(f);
      if (prot) throw new Error(`task ${i} (${t.agent}): file "${f}" is protected ("${prot}" in the config's protect list); do the goal without changing it`);
      const k = normPath(f);
      if (owner.has(k)) throw new Error(`file ${f} owned by both ${owner.get(k)} and ${t.agent}`);
      owner.set(k, t.agent);
    }
  });
  if (!plan.tasks.some((t) => t.phase === "verify")) throw new Error("plan has no verify task");
  const pages = plan.tasks.reduce((n, t) => n + (t.visual?.length ?? 0), 0);
  if (pages > MAX_TARGETS) throw new Error(`the verify tasks' "visual" lists name ${pages} pages together; at most ${MAX_TARGETS}`);
}

function asVerdict(v: Verdict): Verdict {
  if (typeof v?.passed !== "boolean") throw new Error('verdict has no boolean "passed"');
  const failures = Array.isArray(v.failures) ? v.failures.map(String) : [];
  if (!v.passed && !failures.length) failures.push("QA failed without listing failures");
  const notes = Array.isArray(v.notes)
    ? v.notes
        .filter((n) => typeof n === "string" && n.trim())
        .map((n) => n.trim().slice(0, 300))
        .slice(0, 3)
    : [];
  return { passed: v.passed, failures, ...(notes.length ? { notes } : {}) };
}

function asReview(v: Review): Review {
  if (typeof v?.approved !== "boolean") throw new Error('review has no boolean "approved"');
  const issues = Array.isArray(v.issues) ? v.issues.map(String).filter((x) => x.trim()) : [];
  // A rejection without issues gives the architect nothing to fix: treat it as approval.
  return { approved: v.approved || !issues.length, issues };
}

const sig = (f: string) => {
  try {
    return git("hash-object", "--", f);
  } catch {
    return "missing";
  }
};

// ---------- git: checkpoint, commit per round, park failed work, rollback, prune ----------
function isGitRepo() {
  try {
    return git("rev-parse", "--is-inside-work-tree") === "true";
  } catch {
    return false;
  }
}
const hasCommits = () => {
  try {
    git("rev-parse", "--verify", "HEAD");
    return true;
  } catch {
    return false;
  }
};
const branchExists = (b: string) => {
  try {
    git("rev-parse", "--verify", "--quiet", `refs/heads/${b}`);
    return true;
  } catch {
    return false;
  }
};
const dirtyFiles = () => git("status", "--porcelain", "--", ".", NOT_STATE);

/** Refuse a dirty tree, then (after `onClean`, which may switch branches) create the rollback branch. Returns "" outside git. */
function prepareGit(onClean?: () => void): string {
  if (!isGitRepo()) {
    console.warn("warning: not a git repo; no checkpoint, no commits, no diff checks");
    return "";
  }
  if (!hasCommits()) throw new Error("the git repo has no commits yet; make an initial commit first");
  const dirty = dirtyFiles();
  if (dirty) throw new Error(`working tree has uncommitted changes; commit or stash them first, or run "orch rollback" after a stopped run:\n${dirty}`);
  onClean?.();
  const cp = `${BRANCH_PREFIX}checkpoint-${Date.now()}`;
  git("branch", cp);
  console.log(`checkpoint: ${cp} (roll back with: orch rollback)`);
  emit("checkpoint", { branch: cp });
  return cp;
}

/**
 * Stage everything except .orchestrator and commit it. Returns the short hash, or null if nothing changed.
 * `park`: a commit that only ends up on an orchestrator/* side branch (moveWorkAside); it skips the repo's
 * hooks so that saving work before a reset can never be blocked by them.
 */
function commitAll(message: string, park = false): string | null {
  // Not `add -- . NOT_STATE`: when .gitignore lists .orchestrator, git refuses that pathspec
  // ("paths are ignored") and the round's work would stay staged but uncommitted.
  git("add", "-A", "--", ".");
  try {
    git("reset", "-q", "--", ".orchestrator"); // back to HEAD, so a committed config.json stays as it was
  } catch {
    git("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".orchestrator"); // no commit yet
  }
  try {
    git("diff", "--cached", "--quiet");
    return null;
  } catch {
    /* exit 1: there are staged changes */
  }
  if (!park) {
    const found = scanSecrets();
    if (found.length) throw new Error(`refusing to commit: ${found.map((x) => `${x.what} in ${x.file}`).join(", ")}`);
  }
  let identity: string[] = [];
  try {
    git("config", "user.email");
  } catch {
    identity = ["-c", "user.name=orchestrator", "-c", "user.email=orchestrator@localhost"];
  }
  git(...identity, "commit", "-q", ...(park ? ["--no-verify"] : []), "-m", message);
  return git("rev-parse", "--short", "HEAD");
}

function tryCommit(message: string): string | null {
  try {
    const c = commitAll(message);
    if (c) console.log(`committed ${c}: ${message}`);
    return c;
  } catch (e) {
    console.warn(`warning: commit failed, continuing without it: ${msg(e)}`);
    return null;
  }
}

/** Diff stat against the checkpoint, plus files that are new and not committed yet. */
function diffSummary(cp: string) {
  const stat = git("diff", "--stat", cp, "--", ".", NOT_STATE);
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", ".", NOT_STATE);
  return (stat || "(no changes)") + (untracked ? `\nNew files not committed:\n${untracked}` : "");
}

type RoundDiff = { text?: string; truncated?: boolean; unavailable?: string };

/** Snapshot changes since this round began, after the commit attempt (which stages new files). */
function roundDiff(base: string, dirtyAtStart: boolean, secrets: boolean): RoundDiff {
  if (!base) return { unavailable: "Diffs require a Git repository." };
  if (dirtyAtStart) return { unavailable: "A previous round left uncommitted changes, so this round's changes cannot be isolated." };
  if (secrets) return { unavailable: "The diff is hidden because the secret scan found sensitive changes." };
  try {
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-renames", base, "--", ".", NOT_STATE];
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", NOT_STATE], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (untracked) return { unavailable: "The diff is unavailable because some new files could not be staged." };
    const files = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", base, "--", ".", NOT_STATE], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).split("\0");
    if (files.some((f) => ENV_FILE.test(f.replace(/\\/g, "/")))) return { unavailable: "The diff is hidden because it includes an .env file." };
    const text = redactOutput(execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
    return { text: text.slice(0, 100_000), ...(text.length > 100_000 ? { truncated: true } : {}) };
  } catch {
    console.warn("warning: could not capture the round diff (Git failed or the diff exceeds 8 MiB)");
    return { unavailable: "Could not capture the diff (Git failed or the diff exceeds 8 MiB)." };
  }
}

/** Paths with uncommitted changes (modified, added, deleted, untracked; both sides of a rename), outside .orchestrator. */
function changedFiles(): string[] {
  // Not git(): it trims, and the first entry's status may start with a space (" M path").
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "-uall", "--", ".", NOT_STATE], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const entries = raw.split("\0");
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") out.push(entries[++i]); // the old path follows a rename or copy
  }
  return out.filter(Boolean);
}

/** Commit what is left, keep HEAD on a side branch, and reset the current branch to `cp`. */
function moveWorkAside(cp: string, kind: "failed" | "discarded" | "interrupted", message: string): string | null {
  commitAll(message, true); // throws if it cannot commit: never reset over uncommitted work
  if (dirtyFiles()) throw new Error("could not commit the changes; leaving the tree as is");
  if (git("rev-parse", "HEAD") === git("rev-parse", cp)) return null;
  const saved = cp.replace("checkpoint", kind);
  git("branch", saved);
  git("reset", "-q", "--hard", cp);
  return saved;
}

/**
 * After a goal: on pass, drop the checkpoint. On failure in loop mode, move the goal's commits to
 * orchestrator/failed-* (or interrupted-* when a usage limit cut it short, since loop retries it later)
 * and reset to the checkpoint, so the next goal starts from a clean base.
 */
function finishGit(cp: string, goal: string, passed: boolean, park: boolean, interrupted = false) {
  try {
    if (passed) {
      tryCommit(`orch: ${short(goal)} (unfinished)`);
      // The checkpoint is the only way back: drop it only once all the work is safely committed.
      const left = dirtyFiles();
      if (left) {
        console.warn(
          `warning: the goal passed but its work is not fully committed, so ${cp} is kept.\n` +
            `Commit the changes yourself and delete that branch, or undo the goal with: orch rollback\n${left}`,
        );
        return;
      }
      git("branch", "-D", cp);
      return;
    }
    if (!park) {
      tryCommit(`orch: ${short(goal)} (unfinished)`);
      const left = dirtyFiles();
      console.log(`goal not done; its ${left ? "commits and uncommitted changes" : "commits"} sit on top of ${cp}. Roll back with: orch rollback`);
      return;
    }
    const saved = moveWorkAside(cp, interrupted ? "interrupted" : "failed", `orch: ${short(goal)} (unfinished)`);
    if (interrupted && saved) lastParked = saved;
    if (saved) console.log(`goal ${interrupted ? "interrupted" : "failed"}; its work is on branch ${saved}, working tree reset to the checkpoint`);
    git("branch", "-D", cp);
  } catch (e) {
    console.warn(`warning: git cleanup failed (checkpoint ${cp} kept): ${msg(e)}`);
  }
}

const checkpoints = () => git("branch", "--list", `${BRANCH_PREFIX}checkpoint-*`, "--format=%(refname:short)").split("\n").filter(Boolean).sort();

/** Undo a goal: reset the current branch to its checkpoint, keeping the discarded work on a branch. */
function rollback(branch?: string) {
  if (!isGitRepo()) throw new Error("not a git repo; nothing to roll back");
  const cp = branch ?? checkpoints().at(-1);
  if (!cp) throw new Error("no orchestrator/checkpoint-* branch to roll back to");
  if (!branchExists(cp)) throw new Error(`branch ${cp} does not exist`);
  try {
    git("merge-base", "--is-ancestor", cp, "HEAD");
  } catch {
    throw new Error(`${cp} is not an ancestor of the current branch; switch to the branch the goal ran on first`);
  }
  const ahead = Number(git("rev-list", "--count", `${cp}..HEAD`));
  const dirty = dirtyFiles();
  console.log(`rolling back to ${cp}: ${ahead} commit(s) and ${dirty ? dirty.split("\n").length : 0} uncommitted change(s) to discard`);
  const saved = moveWorkAside(cp, "discarded", "orch: work discarded by rollback");
  git("branch", "-D", cp);
  const lr = readJsonFile<LastRun | null>(LAST_RUN, null);
  if (lr?.checkpoint === cp) writeLastRun({ ...lr, checkpoint: undefined, status: "failed" });
  console.log(saved ? `rolled back; the discarded work is kept on branch ${saved}` : "nothing to discard; checkpoint removed");
}

// ---------- --branch / --pr: a branch per goal, and a pull request when it passes ----------
/** `shared`: the branch of a whole brief, which its goals build up one after another. */
type GoalBranch = { branch: string; base: string; shared?: boolean };

/** orch/<id>-<slug>: the queue id (or a time stamp for `orch run`) and the goal's first words. */
function goalBranchName(goal: string, id?: number): string {
  const slug =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "goal";
  const name = `orch/${id ?? Date.now().toString(36)}-${slug}`;
  let n = 1;
  while (branchExists(n === 1 ? name : `${name}-${n}`)) n++;
  return n === 1 ? name : `${name}-${n}`;
}

/**
 * Switch to the goal's branch: a new one from the current commit, or, for a goal from a brief, the brief's shared
 * branch orch/brief-<id> (created on its first goal), so each goal builds on the ones before. Needs a branch, not a
 * detached HEAD.
 */
function startGoalBranch(goal: string, id?: number, brief?: string): GoalBranch {
  let base: string;
  try {
    base = git("symbolic-ref", "--quiet", "--short", "HEAD");
  } catch {
    throw new Error("--branch needs a checked-out branch to start from (HEAD is detached)");
  }
  const shared = brief ? `orch/brief-${brief}` : undefined;
  const branch = shared ?? goalBranchName(goal, id);
  if (shared && branchExists(shared)) git("switch", "-q", shared);
  else git("switch", "-q", "-c", branch);
  console.log(`goal branch: ${branch} (from ${base}, which this goal does not change)`);
  emit("goal_branch", { branch, base, ...(shared ? { shared: true } : {}) });
  return { branch, base, shared: !!shared };
}

/**
 * After a goal on its own branch: commit what is left, switch back to where it started and drop the checkpoint
 * (the base branch never moved). The goal's work stays on its branch; an empty one is deleted. On pass with --pr,
 * push it and open a pull request. If the work cannot be committed, stay on the goal branch and keep the checkpoint.
 */
function finishGoalBranch(cp: string, gb: GoalBranch, goal: string, passed: boolean, o: Opts, lr: LastRun, interrupted = false) {
  try {
    // On a brief's shared branch a failed goal must not stay under the next goals: park it, reset to the checkpoint.
    if (gb.shared && !passed) {
      const saved = moveWorkAside(cp, interrupted ? "interrupted" : "failed", `orch: ${short(goal)} (unfinished)`);
      if (saved) console.log(`goal ${interrupted ? "interrupted" : "failed"}; its work is on branch ${saved}, and ${gb.branch} is back where the goal started`);
      if (interrupted && saved) lastParked = saved;
    } else tryCommit(`orch: ${short(goal)} (unfinished)`);
    const left = dirtyFiles();
    if (left) {
      console.warn(`warning: the goal's work is not fully committed, so orch stays on ${gb.branch} and keeps ${cp}:\n${left}`);
      return;
    }
    git("switch", "-q", gb.base);
    git("branch", "-D", cp);
    if (Number(git("rev-list", "--count", `${gb.base}..${gb.branch}`)) === 0) {
      git("branch", "-D", gb.branch);
      console.log(`back on ${gb.base}; the goal changed nothing, so ${gb.branch} was deleted`);
      lr.branch = undefined;
      return;
    }
    console.log(`back on ${gb.base} (unchanged); the goal's work is on branch ${gb.branch}`);
    if (interrupted && !gb.shared) lastParked = gb.branch;
    if (passed && o.pr) lr.pr = gb.shared ? briefPullRequest(gb, lr) : openPullRequest(gb, goal, lr);
  } catch (e) {
    console.warn(`warning: could not finish the goal branch (${msg(e)}); you may still be on ${gb.branch}`);
  }
}

/** The pull request's description: the goal, what each round did, the checks, the cost. */
function prBody(goal: string, lr: LastRun): string {
  const rounds = lr.state as { round: number; plan: string; passed: boolean; checks?: { name: string; ok: boolean }[]; cost: number }[];
  const lines = rounds.map(
    (r) =>
      `- Round ${r.round}: ${r.plan} (${r.passed ? "passed" : "failed"}` +
      (r.checks?.length ? `; checks: ${r.checks.map((c) => `${c.name} ${c.ok ? "ok" : "failed"}`).join(", ")}` : "") +
      `; $${r.cost.toFixed(2)})`,
  );
  return (
    `${goal}\n\n## What YAAIORCH did\n${lines.join("\n")}\n\n` +
    `QA passed in round ${rounds.length}; agent calls cost $${lr.cost.toFixed(2)} in total.\n\n` +
    (lr.issue ? `Closes #${lr.issue}\n\n` : "") +
    `Opened by [YAAIORCH](https://github.com/alyn3d/yaaiorch). Review it like any other pull request.\n`
  );
}

/**
 * A brief's shared branch: one pull request for the whole brief, opened after its first passed goal (the brief's
 * first line as title, the brief as body) and updated by pushing after each later one.
 */
function briefPullRequest(gb: GoalBranch, lr: LastRun): string | undefined {
  const state = readJsonFile<{ pr?: string; brief?: string }>(SPEC_STATE, {});
  if (state.pr && gb.branch === `orch/brief-${state.brief}`) {
    try {
      execFileSync("git", ["push", "-q", "origin", gb.branch], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 120_000,
      });
      console.log(`pull request updated: ${state.pr}`);
      emit("pr", { branch: gb.branch, base: gb.base, url: state.pr, updated: true });
    } catch (e) {
      console.warn(`warning: could not push ${gb.branch} (${msg(e)})`);
      emit("pr", { branch: gb.branch, base: gb.base, url: state.pr, error: msg(e) });
    }
    return state.pr;
  }
  const spec = readSpec();
  const title =
    spec
      .split("\n")
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, "") ?? "YAAIORCH brief";
  const url = openPullRequest(
    gb,
    title,
    lr,
    `${spec.slice(0, 6000)}\n\n---\nBuilt goal by goal by [YAAIORCH](https://github.com/alyn3d/yaaiorch); each goal is one or more commits on this branch, and this pull request grows until the brief is done.\n`,
  );
  if (url && existsSync(SPEC_STATE)) writeFileAtomic(SPEC_STATE, JSON.stringify({ ...readJsonFile<object>(SPEC_STATE, {}), pr: url }));
  return url;
}

/** Push the goal branch to origin and open a pull request with gh. Returns its URL; failures are reported, never thrown. */
function openPullRequest(gb: GoalBranch, goal: string, lr: LastRun, body?: string): string | undefined {
  let url: string | undefined;
  let error: string | undefined;
  try {
    if (!git("remote").split("\n").includes("origin")) throw new Error('no "origin" remote to push to');
    // Never wait for a credential prompt: an unattended run would hang.
    execFileSync("git", ["push", "-q", "-u", "origin", gb.branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 120_000,
    });
    const gh = resolveCommand(process.env.GH_BIN ?? "gh");
    if (gh.missing) throw new Error(`pushed ${gb.branch}, but gh (GitHub CLI) was not found; open the pull request yourself`);
    // The title is the only goal text on a command line; strip what a shell fallback could misread.
    const title = (gh.shell ? goal.replace(/[^\w .,:()/+-]/g, "") : goal).replace(/\s+/g, " ").trim().slice(0, 72) || "YAAIORCH goal";
    const r = spawnSync(gh.file, [...gh.pre, "pr", "create", "--base", gb.base, "--head", gb.branch, "--title", title, "--body-file", "-"], {
      input: body ?? prBody(goal, lr),
      encoding: "utf8",
      shell: gh.shell,
      windowsHide: true,
      timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout || String(r.error ?? "")).trim().slice(0, 300)}`);
    url = /https?:\/\/\S+/.exec(r.stdout)?.[0];
    console.log(`pull request: ${url ?? r.stdout.trim()}`);
  } catch (e) {
    error = msg(e);
    console.warn(`warning: no pull request (${error})`);
  }
  emit("pr", { branch: gb.branch, base: gb.base, url, error });
  return url;
}

// ---------- --pr: wait for the pull request's CI, and fix it when it fails ----------
type CiResult = { state: "pass" | "fail" | "none" | "timeout"; failed: { name: string; link?: string }[] };

/** gh pr checks, until nothing is pending (or the time is up). No checks at all after a while: "none". */
async function waitForChecks(pr: string): Promise<CiResult> {
  const gh = resolveCommand(process.env.GH_BIN ?? "gh");
  if (gh.missing) return { state: "none", failed: [] };
  const poll = Number(process.env.ORCH_CI_POLL_MS ?? 30_000);
  const deadline = Date.now() + Number(process.env.ORCH_CI_TIMEOUT_MS ?? 30 * 60_000);
  const noneAfter = Date.now() + Number(process.env.ORCH_CI_NONE_MS ?? 120_000);
  for (;;) {
    // gh exits non-zero while checks are pending or failing; the JSON is what counts.
    const r = spawnSync(gh.file, [...gh.pre, "pr", "checks", pr, "--json", "name,bucket,link"], {
      encoding: "utf8",
      shell: gh.shell,
      windowsHide: true,
      timeout: 60_000,
    });
    let checks: { name?: string; bucket?: string; link?: string }[] | null = null;
    try {
      checks = JSON.parse(r.stdout || "null");
    } catch {
      /* "no checks reported" is plain text */
    }
    if (Array.isArray(checks) && checks.length) {
      const pending = checks.some((c) => c.bucket === "pending");
      const failed = checks.filter((c) => c.bucket === "fail").map((c) => ({ name: String(c.name ?? "check"), link: c.link }));
      if (!pending) return { state: failed.length ? "fail" : "pass", failed };
    } else if (Date.now() > noneAfter) return { state: "none", failed: [] };
    if (Date.now() > deadline) return { state: "timeout", failed: [] };
    await sleep(poll);
  }
}

/** The failing part of a GitHub Actions job's log (gh run view --log-failed), else the link. */
function checkLog(c: { name: string; link?: string }): string {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(c.link ?? "");
  if (m) {
    const gh = resolveCommand(process.env.GH_BIN ?? "gh");
    const r = gh.missing
      ? null
      : spawnSync(gh.file, [...gh.pre, "run", "view", m[1], "--job", m[2], "--log-failed"], {
          encoding: "utf8",
          shell: gh.shell,
          windowsHide: true,
          timeout: 120_000,
        });
    const log = (r?.stdout ?? "").trim();
    if (log) return `### ${c.name}\n${log.slice(-4000)}`;
  }
  return `### ${c.name}\n(no log available${c.link ? `; see ${c.link}` : ""})`;
}

/**
 * After a passed goal opened or updated its pull request: wait for its CI, and while checks fail (and fixes are
 * left), run a fix goal on the PR's branch with the failing logs, push, and wait again. Records the end state in
 * `lr.ci`. Returns what the fixes cost. Never throws for CI trouble.
 */
async function watchPullRequest(gb: GoalBranch, goal: string, o: Opts, lr: LastRun): Promise<number> {
  let cost = 0;
  for (let attempt = 0; ; attempt++) {
    console.log(`waiting for the CI checks of ${lr.pr}...`);
    const ci = await waitForChecks(lr.pr!);
    lr.ci = ci.state;
    emit("ci", { pr: lr.pr, state: ci.state, attempt, failed: ci.failed.map((c) => c.name) });
    console.log(`CI: ${ci.state}${ci.failed.length ? ` (${ci.failed.map((c) => c.name).join(", ")})` : ""}`);
    if (ci.state !== "fail" || attempt >= o.ciFixes) return cost;
    const logs = ci.failed.map(checkLog).join("\n\n");
    const fixGoal =
      `${goal}\n\nThe work for this goal is done, but its pull request (${lr.pr}) fails its CI checks. Find out why and fix it ` +
      `in the code or tests. Do not weaken, skip or delete checks or tests to make them pass.\n\nFailing checks:\n${logs}`;
    try {
      git("switch", "-q", gb.branch);
    } catch (e) {
      console.warn(`could not switch to ${gb.branch} to fix CI (${msg(e)})`);
      return cost;
    }
    const fixOpts: Opts = { ...o, approvePlan: false, maxRounds: Math.min(o.maxRounds, 3) };
    const ctx: RunCtx = {
      budget: { spent: 0, cap: o.maxCost, reserved: 0, launching: 0 },
      timeoutMs: o.agentTimeoutMs,
      usageCap: o.usageCap,
      onLimit: o.onLimit,
    };
    const fixLr: LastRun = { goal: fixGoal, status: "running", cost: 0, state: [] };
    let cp = "";
    let fixed = false;
    emit("goal_start", { goal: `Fix CI of ${lr.pr}`, maxRounds: fixOpts.maxRounds, dryRun: false, power: o.power, maxCost: o.maxCost, ci: true });
    try {
      cp = prepareGit();
      fixed = await runGoalInner(fixGoal, fixOpts, cp, ctx, fixLr, null, `fix CI of ${short(goal)}`);
      emit("goal_end", { passed: fixed, cost: round4(ctx.budget.spent), ...(ctx.budget.tokens ? { tokens: ctx.budget.tokens } : {}) });
    } catch (e) {
      emit("goal_end", {
        passed: false,
        error: msg(e),
        cost: round4(ctx.budget.spent),
        ...(ctx.budget.tokens ? { tokens: ctx.budget.tokens } : {}),
      });
      if (isFatal(e)) console.warn(`CI fix stopped: ${msg(e)}`);
    } finally {
      cost += ctx.budget.spent;
      // Keep what the fix committed if it passed, else drop it: the branch stays as the PR had it.
      try {
        if (fixed) tryCommit(`orch: fix CI of ${short(goal)}`);
        else if (cp) moveWorkAside(cp, "failed", `orch: CI fix of ${short(goal)} (unfinished)`);
        if (cp && branchExists(cp)) git("branch", "-D", cp);
        git("switch", "-q", gb.base);
      } catch (e) {
        console.warn(`could not clean up after the CI fix (${msg(e)}); you may still be on ${gb.branch}`);
      }
    }
    if (!fixed) {
      console.warn("the CI fix did not pass its own checks and QA; leaving the pull request as it is");
      return cost;
    }
    try {
      execFileSync("git", ["push", "-q", "origin", gb.branch], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 120_000,
      });
    } catch (e) {
      console.warn(`could not push the CI fix (${msg(e)})`);
      return cost;
    }
  }
}

/** Where the last interrupted goal's work was put (finishGit / finishGoalBranch), for its next attempt. */
let lastParked: string | undefined;

/**
 * Bring an interrupted attempt's commits back onto the current branch: a fast-forward when nothing moved since,
 * else a cherry-pick. Returns their subjects, or null (nothing there, or it does not apply; the goal starts fresh).
 * The parked branch is deleted once its work is back.
 */
function applyParked(branch: string): string[] | null {
  if (!branchExists(branch)) return null;
  const base = git("merge-base", "HEAD", branch);
  const commits = git("rev-list", "--reverse", `${base}..${branch}`).split("\n").filter(Boolean);
  if (!commits.length) return null;
  try {
    if (git("rev-parse", "HEAD") === base) git("merge", "-q", "--ff-only", branch);
    else {
      let identity: string[] = [];
      try {
        git("config", "user.email");
      } catch {
        identity = ["-c", "user.name=orchestrator", "-c", "user.email=orchestrator@localhost"];
      }
      git(...identity, "cherry-pick", "--allow-empty", ...commits);
    }
  } catch (e) {
    try {
      git("cherry-pick", "--abort");
    } catch {
      /* nothing to abort */
    }
    console.warn(`could not bring back the interrupted work from ${branch} (${msg(e)}); starting the goal fresh, the branch is kept`);
    return null;
  }
  const subjects = git("log", "--format=%s", `-n${commits.length}`, "HEAD").split("\n").filter(Boolean).reverse();
  git("branch", "-D", branch);
  console.log(`resuming: brought back ${commits.length} commit(s) of the interrupted attempt from ${branch}`);
  emit("resumed", { branch, commits: subjects });
  return subjects;
}

/** Delete orchestrator/* branches whose timestamp is older than `days`. Never touches the current branch. */
function prune(days: number) {
  if (!isGitRepo()) throw new Error("not a git repo");
  const current = git("rev-parse", "--abbrev-ref", "HEAD");
  const cutoff = Date.now() - days * 86_400_000;
  const branches = git("branch", "--list", `${BRANCH_PREFIX}*`, "--format=%(refname:short)").split("\n").filter(Boolean);
  let deleted = 0;
  for (const b of branches) {
    const ts = Number(/-(\d{13})$/.exec(b)?.[1]);
    if (!ts || ts >= cutoff || b === current) continue;
    git("branch", "-D", b);
    console.log(`deleted ${b} (${new Date(ts).toISOString().slice(0, 10)})`);
    deleted++;
  }
  console.log(`pruned ${deleted} branch(es) older than ${days} day(s); ${branches.length - deleted} left`);
}

// ---------- doctor: first-run checks ----------
type Finding = { name: string; level: "ok" | "warn" | "fail"; detail: string };

function cli(cmd: string, args: string[]) {
  return spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

function doctor(): Finding[] {
  const f: Finding[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  f.push({ name: "node", level: major >= 20 ? "ok" : "fail", detail: `v${process.versions.node}${major >= 20 ? "" : " (need 20 or newer)"}` });

  const ver = claudeSync(["--version"]);
  const claudeOk = ver.status === 0;
  const via = claudeBin().shell ? ` (through ${claudeBin().via})` : "";
  f.push({
    name: "claude",
    level: claudeOk ? "ok" : "fail",
    detail: claudeOk ? `${ver.stdout.trim()}${via}` : `"${CLAUDE} --version" failed${via}; install Claude Code or set CLAUDE_BIN`,
  });
  if (claudeOk) {
    const auth = claudeSync(["auth", "status", "--json"]);
    let loggedIn: boolean | undefined;
    try {
      loggedIn = JSON.parse(auth.stdout).loggedIn;
    } catch {
      /* older CLI or fake: unknown */
    }
    f.push(
      loggedIn === true
        ? { name: "claude login", level: "ok", detail: "logged in" }
        : loggedIn === false
          ? { name: "claude login", level: "fail", detail: 'not logged in; run "claude auth login"' }
          : { name: "claude login", level: "warn", detail: "could not read login status" },
    );
  }

  const g = cli("git", ["--version"]);
  if (g.status !== 0) f.push({ name: "git", level: "warn", detail: "git not found: no checkpoints, commits or rollback" });
  else if (!isGitRepo()) f.push({ name: "repo", level: "warn", detail: "not a git repo: no checkpoints, commits or rollback" });
  else if (!hasCommits()) f.push({ name: "repo", level: "fail", detail: "git repo has no commits; make an initial commit" });
  else {
    const dirty = dirtyFiles();
    const stale = checkpoints();
    f.push({
      name: "repo",
      level: dirty ? "fail" : "ok",
      detail: dirty ? `uncommitted changes (${dirty.split("\n").length}); commit, stash or "orch rollback"` : "clean git repo",
    });
    if (stale.length)
      f.push({ name: "checkpoints", level: "warn", detail: `${stale.length} leftover checkpoint(s), latest ${stale.at(-1)}: "orch rollback" or "orch prune"` });
  }
  try {
    const checks = loadChecks(readJsonFile<Config>(CONFIG_FILE, {}));
    const names = Object.keys(checks);
    f.push({ name: "checks", level: names.length ? "ok" : "warn", detail: names.length ? names.join(", ") : "none found; QA can only read the code" });
  } catch (e) {
    f.push({ name: "checks", level: "fail", detail: msg(e) });
  }
  // Browser checks: only when the repo asks for them, so a missing browser never nags anyone else.
  try {
    const cfg = readJsonFile<Config>(CONFIG_FILE, {});
    if (cfg.serve && cfg.visual !== false) {
      const serve = parseServe(cfg.serve);
      const b = findBrowser();
      f.push(
        !hasWebSocket()
          ? { name: "browser", level: "fail", detail: "browser checks need Node.js 22 or newer" }
          : b
            ? { name: "browser", level: "ok", detail: `${b.path} (${b.via}); checks open ${serve.url}` }
            : {
                name: "browser",
                level: "fail",
                detail:
                  'config "serve" turns on browser checks, but no Chrome, Edge, Chromium or Brave was found; run "orch browser install" or set YAAIORCH_BROWSER',
              },
      );
    }
  } catch (e) {
    f.push({ name: "browser", level: "fail", detail: msg(e) });
  }
  return f;
}

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);

/** `fast`: round 1 is one generalist agent doing the whole goal, verified by the checks; later rounds are the full loop. */
/** `onLimit`: on a Claude usage limit, wait for the reset and retry the goal (default), or stop. */
type Opts = {
  maxRounds: number;
  power: Power;
  dryRun: boolean;
  park: boolean;
  agentTimeoutMs: number;
  maxCost?: number;
  fast: boolean;
  /** Files changed outside every task's list fail the round (else QA is told). */
  strictFiles: boolean;
  /** loop: spending cap over all goals of this loop run. */
  maxCostTotal?: number;
  models: Models;
  onLimit: "wait" | "stop";
  usageCap: UsageCap;
  plugins: PluginChoice;
  brief: boolean;
  notes: boolean;
  critic: boolean;
  /** Fix rounds continue an implementer's session from the round before (see pickSession). */
  resume: boolean;
  /** The critic reviews each round's change against the goal. */
  diffCritic: boolean;
  /** Reviewers for bugs and security: null = off, [] = the built-in reviewer, else these agents. */
  review: string[] | null;
  /** Each goal on its own orch/<id>-<slug> branch; the starting branch is never changed. */
  branch: boolean;
  /** With branch: push a passed goal's branch and open a pull request (gh). */
  pr: boolean;
  /** Wait for a human to approve, edit or reject each plan before building. */
  approvePlan: boolean;
  /** When the queue runs dry, check the brief (spec.md) against the code and queue what is missing. */
  coverage: boolean;
  /** loop: how often a failed goal is tried again, one power tier higher each time, before its dependents are blocked. */
  retries: number;
  /** loop: where to pull goals from when the queue runs dry (orch intake). */
  intake: IntakeSource[];
  /** Paths no task may change (default: .github/workflows/). */
  protect: string[];
  /** Refuse to commit known key formats, private keys and .env files. */
  secretScan: boolean;
  /** Comment on the GitHub issue a goal came from (start, done, failed, blocked). */
  issueComments: boolean;
  /** --pr: wait for the pull request's CI checks, and how many fix goals to run when they fail (-1: do not wait). */
  ciFixes: number;
  /** With config "serve": open the pages verify tasks name in a browser and give QA the screenshots. */
  visual: boolean;
};

/** Run one build task; trust the diff, not the report. Re-dispatch once on phantom completion. */
async function execute(t: Task, agent: Entry, model: string, ctx: RunCtx, resume?: { id: string; round: number }): Promise<Result> {
  const task =
    (t.files?.length ? `${t.task}\n\nYour files (touch only these):\n${t.files.map((f) => `- ${f}`).join("\n")}` : t.task) +
    (t.figma ? `\n\nFigma: ${t.figma}` : "") +
    (t.skills?.length ? `\n\nBefore starting, load these skills with the Skill tool: ${t.skills.join(", ")}` : "") +
    TASK_FORMAT;
  const cold = (ctx.repoContext ? `${ctx.repoContext}## Your task\n` : "") + task;
  // A resumed session already holds the brief, the files it read and what it did; it gets only the new task.
  const resumed = resume
    ? `Round ${resume.round} of this goal (your work in this session) did not pass. This is your task for the next round. ` +
      `Other agents may have changed files since, so re-read a file before you edit it.\n\n## Your task\n${task}`
    : "";
  let cost = 0;
  let tokens: TokenUsage | undefined;
  let session = resume?.id;
  let prompt = resume ? resumed : cold;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = new Map((t.files ?? []).map((f) => [f, sig(f)]));
    let r: Reply;
    try {
      r = await run(agent, model, prompt, ctx, false, session);
    } catch (e) {
      // The session may be gone (cleaned up, another machine): start cold once. Never after a timeout or a fatal error.
      if (!session || isFatal(e) || /timed out after \d/.test(msg(e))) throw e;
      console.warn(`${t.agent}: resuming its session failed (${msg(e).slice(0, 160)}); starting cold`);
      prompt = cold;
      r = await run(agent, model, prompt, ctx, false);
    }
    cost += r.cost;
    tokens = addTokenUsage(tokens, r.tokens);
    const touched = (t.files ?? []).filter((f) => sig(f) !== before.get(f));
    if (!t.files?.length || touched.length || !/Status:\s*COMPLETE/i.test(r.text))
      return { agent: t.agent, out: r.text, touched, cost, tokens, session: r.session };
    console.warn(`phantom completion by ${t.agent}; re-dispatching`);
    // Same session when there is one and resuming is on: the agent sees what it claimed and is told what is missing.
    if (ctx.resume && r.session) {
      session = r.session;
      prompt =
        `You replied "Status: COMPLETE", but none of your files changed:\n${t.files.map((f) => `- ${f}`).join("\n")}\n` +
        `Make the changes now, in those files.${TASK_FORMAT}`;
    } else {
      session = undefined;
      prompt = cold;
    }
  }
  return { agent: t.agent, out: "PHANTOM: no diff after 2 attempts", touched: [], cost, tokens };
}

/** A session from the round before, from a task of the same agent; one at most per agent and session. */
type Session = { agent: string; id: string; files: string[]; round: number };

/**
 * Which earlier session a new task continues: the same agent's task from the round before that shares a file
 * with it (most shared files wins). With no file lists on either side, only when the agent had exactly one
 * task then and has exactly one now. Otherwise the task starts cold.
 */
function pickSession(t: Task, sessions: Session[], tasksOfAgent: number): Session | undefined {
  const mine = sessions.filter((s) => s.agent === t.agent);
  const files = new Set((t.files ?? []).map(normPath));
  let best: Session | undefined;
  let bestShared = 0;
  for (const s of mine) {
    const shared = s.files.filter((f) => files.has(normPath(f))).length;
    if (shared > bestShared) [best, bestShared] = [s, shared];
  }
  if (best) return best;
  if (mine.length === 1 && tasksOfAgent === 1 && !files.size && !mine[0].files.length) return mine[0];
  return undefined;
}

/** Ask the architect for a plan; on bad JSON or a rejected plan, ask once more with the reason. */
/**
 * `previous`: what the last round planned and changed, so a fix round builds on it instead of starting blind.
 * `brief`: the project brief if one exists, `""` to ask for one, `null` when briefs are off.
 */
async function makePlan(
  architect: Entry,
  workers: Entry[],
  skills: Entry[],
  goal: string,
  failures: string[],
  note: string,
  model: string,
  ctx: RunCtx,
  previous = "",
  brief: string | null = null,
  notes = "",
) {
  const base =
    `Goal: ${goal}\n\nAvailable agents:\n${workers.map((a) => `- ${a.name}: ${a.description}`).join("\n")}\n\n` +
    `Available skills:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(none)"}\n` +
    (brief
      ? `\nProject brief (your own notes from an earlier run; rely on it instead of re-reading the whole repo, and add a "brief" ` +
        `field with a corrected version only if it is wrong or missing something important):\n${brief}\n`
      : brief === ""
        ? `\nNo project brief exists yet. Add a "brief" field: your notes on this repo for later rounds and goals (at most 250 ` +
          `words: stack, layout, conventions, how to run the checks).\n`
        : "") +
    (notes ? `\nNotes from earlier goals in this repo (pitfalls and decisions; follow them unless this goal says otherwise):\n${notes}\n` : "") +
    specForPrompt() +
    VISUAL_HINT +
    (previous ? `\n${previous}\n` : "") +
    (failures.length ? `\nPrevious QA failures to fix:\n- ${failures.join("\n- ")}\n` : "") +
    (note ? `\n${note}\n` : "") +
    "\nProduce the plan." +
    PLAN_FORMAT;
  let prompt = base;
  let cost = 0;
  for (let attempt = 1; ; attempt++) {
    const r = await run(architect, model, prompt, ctx, true);
    cost += r.cost;
    try {
      const plan = extractJson<Plan>(r.text);
      validate(plan, workers);
      return { plan, cost };
    } catch (e) {
      if (attempt >= 2) throw e;
      console.warn(`plan rejected (${msg(e)}); asking the architect again`);
      prompt = `${base}\n\nYour previous reply was rejected: ${msg(e)}\nFix that and reply with the JSON plan only.`;
    }
  }
}

/**
 * Fast-path plan: one `dev` task for the whole goal on the tier's strong model (heavy), no file list.
 * Verified by the repo's checks; when there are none, a QA task is added so something still verifies.
 */
function directPlan(goal: string, checks: Record<string, string>, brief: string | null = null, notes = ""): Plan {
  const commands = Object.values(checks);
  const task =
    `Goal: ${goal}\n\n` +
    (brief ? `Project brief (notes on this repo from an earlier run):\n${brief}\n\n` : "") +
    (notes ? `Lessons from earlier goals in this repo:\n${notes}\n\n` : "") +
    `You are doing this goal alone: read the relevant code, then make the complete change ` +
    `(code and tests) following the repository's conventions.` +
    (commands.length
      ? ` Afterwards the orchestrator runs these checks and they must pass (you can run them yourself): ${commands.join(", ")}.`
      : " No automated checks are configured, so a reviewer will check the result.");
  return {
    summary: "Direct attempt (fast path): one agent does the whole goal",
    tasks: [
      { agent: "dev", phase: "build", task, heavy: true },
      ...(commands.length ? [] : [{ agent: "qa", phase: "verify" as Phase, task: "Check that the goal is fully met and nothing is broken." }]),
    ],
  };
}

/** Failures compared across rounds: case, spacing and numbers (timings, line counts) ignored. */
const failureKey = (fs: string[]) =>
  fs
    .map((f) =>
      f
        .toLowerCase()
        .replace(/\d+(\.\d+)?/g, "#")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .sort()
    .join("\n");

type LastRun = {
  goal: string;
  status: "running" | "passed" | "failed";
  checkpoint?: string;
  cost: number;
  tokens?: TokenUsage;
  state: unknown[];
  /** --branch: the goal's branch and the one it started from; --pr: the pull request's URL. */
  branch?: string;
  base?: string;
  pr?: string;
  /** The GitHub issue the goal came from: its pull request closes it. */
  issue?: number;
  /** --pr: how the pull request's CI checks ended (pass, fail, none, timeout) after any fixes. */
  ci?: string;
};

/** First line of brief.md: the commit the brief describes, so a brief can tell when it has gone stale. */
const BRIEF_STAMP = /^<!-- orch: written at commit ([0-9a-f]{7,40}) -->\r?\n?/;
/** A brief older than this many changed files (since its commit) is sent back to the architect to check. */
const BRIEF_STALE_FILES = 20;

function readBriefFile(): { text: string; commit?: string } {
  if (!existsSync(BRIEF_FILE)) return { text: "" };
  const raw = readFileSync(BRIEF_FILE, "utf8");
  const m = BRIEF_STAMP.exec(raw);
  return { text: raw.slice(m ? m[0].length : 0).trim(), commit: m?.[1] };
}
const readBrief = (): string => readBriefFile().text;
const headCommit = (): string | undefined => {
  try {
    return isGitRepo() ? git("rev-parse", "HEAD") : undefined;
  } catch {
    return undefined; // no commits yet
  }
};

function writeBrief(text: unknown, quiet = false) {
  if (typeof text !== "string" || text.trim().length < 20) return;
  const existed = existsSync(BRIEF_FILE);
  const commit = headCommit();
  mkdirSync(DIR, { recursive: true });
  writeFileAtomic(BRIEF_FILE, (commit ? `<!-- orch: written at commit ${commit} -->\n` : "") + text.trim().slice(0, MAX_BRIEF) + "\n");
  if (!quiet) console.log(`project brief ${existed ? "updated" : "written"}: ${BRIEF_FILE}`);
}

/** How many files changed since the brief's commit; Infinity if that commit is gone; 0 outside git or unstamped. */
function briefAge(commit?: string): number {
  if (!commit || !isGitRepo()) return 0;
  try {
    return git("diff", "--name-only", commit, "HEAD", "--", ".", NOT_STATE).split("\n").filter(Boolean).length;
  } catch {
    return Infinity; // rebased or pruned away
  }
}

/**
 * The brief for this goal: with many files changed since it was written, it goes to the architect with a
 * request to check it. `stale` tells the caller to re-stamp it if the architect finds nothing to correct.
 */
function briefForGoal(): { text: string; stale: boolean } {
  const { text, commit } = readBriefFile();
  if (!text) return { text: "", stale: false };
  const age = briefAge(commit);
  if (age < BRIEF_STALE_FILES) return { text, stale: false };
  const since = age === Infinity ? "at a commit that is no longer in this history" : `${age} changed files ago`;
  console.log(`project brief written ${since}; asking the architect to check it`);
  return {
    text: `${text}\n\n(This brief was written ${since} and may be out of date: check it against the repo and add a "brief" field with a corrected version if anything changed.)`,
    stale: true,
  };
}

/**
 * `orch learn`: one read-only call to the architect that studies the repo and writes (or corrects) the
 * project brief, so the first goal does not pay for it. Respects --power, --model, --max-cost, --usage-cap
 * and the plugin choice like a goal does.
 */
async function learn(o: Opts) {
  const roster = discoverAgents();
  const architect = roster.find((a) => a.name === "architect")!;
  writeBuiltins(roster);
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  const checks = loadChecks(cfg);
  writeAgentSettings(cfg, checks, o.plugins);
  const ctx: RunCtx = {
    budget: { spent: 0, cap: o.maxCost, reserved: 0, launching: 0 },
    timeoutMs: o.agentTimeoutMs,
    usageCap: o.usageCap,
    onLimit: o.onLimit,
  };
  const old = readBrief();
  const commands = Object.entries(checks).map(([n, c]) => `${n}: ${c}`);
  const prompt =
    `Study this repository so that later goals need not explore it from scratch. Read the README and docs, the build ` +
    `and package files, the folder layout, the main entry points, and a few typical source and test files. Do not edit anything.\n` +
    (commands.length ? `\nThe orchestrator runs these checks after every build:\n- ${commands.join("\n- ")}\n` : "") +
    (old ? `\nThe current project brief, to check, correct and extend:\n${old}\n` : "") +
    LEARN_FORMAT;
  emit("learn_start", { power: o.power });
  let ok = false;
  try {
    const r = await run(architect, modelFor(o.power, o.models, "architect", "architect"), prompt, ctx, true);
    const { brief } = extractJson<{ brief?: unknown }>(r.text);
    if (typeof brief !== "string" || brief.trim().length < 20) throw new Error("the architect returned no brief");
    writeBrief(brief);
    console.log(`\n${readBrief()}\n`);
    ok = true;
  } finally {
    // The daily budget in the UI counts this cost too.
    emit("learn_end", { ok, cost: round4(ctx.budget.spent), ...(ctx.budget.tokens ? { tokens: ctx.budget.tokens } : {}) });
    console.log(`cost: ${usd(ctx.budget.spent)}${o.maxCost !== undefined ? ` of ${usd(o.maxCost)}` : ""}`);
  }
}

/** Markers around the section `orch share` maintains in CLAUDE.md; everything outside them is left alone. */
const SHARE_START = "<!-- yaaiorch:learned:start -->";
const SHARE_END = "<!-- yaaiorch:learned:end -->";

/** CLAUDE.md with the learned section put in (replacing an earlier one between the markers, else appended). */
function withSharedSection(current: string, body: string): string {
  const block = `${SHARE_START}\n## Learned by YAAIORCH\n\n${body.trim()}\n${SHARE_END}`;
  const a = current.indexOf(SHARE_START);
  const b = current.indexOf(SHARE_END);
  if (a >= 0 && b > a) return current.slice(0, a) + block + current.slice(b + SHARE_END.length);
  return (current.trim() ? `${current.trimEnd()}\n\n` : "") + `${block}\n`;
}

/** Commit `content` as `path` on a new branch off HEAD, without touching the working tree or the index. */
function commitOnSideBranch(branch: string, path: string, content: string, message: string) {
  const index = join(DIR, `share-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const g = (args: string[], input?: string) => execFileSync("git", args, { encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    g(["read-tree", "HEAD"]);
    const blob = g(["hash-object", "-w", "--stdin"], content);
    g(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    const tree = g(["write-tree"]);
    const commit = g(["commit-tree", tree, "-p", "HEAD", "-m", message]);
    g(["branch", branch, commit]);
  } finally {
    rmSync(index, { force: true });
  }
}

/** `orch share`: the brief and lasting lessons as a CLAUDE.md section, on a branch to review. */
async function share(o: Opts) {
  const brief = readBrief();
  const notes = existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, "utf8").trim() : "";
  if (!brief && !notes) throw new Error(`nothing learned yet: no ${BRIEF_FILE} or ${NOTES_FILE} (run a goal or "orch learn" first)`);
  if (!o.dryRun) git("rev-parse", "--verify", "HEAD"); // needs a commit to branch from
  const roster = discoverAgents();
  const architect = roster.find((a) => a.name === "architect")!;
  writeBuiltins(roster);
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  writeAgentSettings(cfg, loadChecks(cfg), o.plugins);
  const ctx: RunCtx = {
    budget: { spent: 0, cap: o.maxCost, reserved: 0, launching: 0 },
    timeoutMs: o.agentTimeoutMs,
    usageCap: o.usageCap,
    onLimit: o.onLimit,
  };
  let current = "";
  try {
    current = git("show", "HEAD:CLAUDE.md");
  } catch {
    /* no CLAUDE.md yet */
  }
  const ours = current.indexOf(SHARE_START) >= 0 ? current.slice(current.indexOf(SHARE_START), current.indexOf(SHARE_END)) : "";
  const prompt =
    `Write the section of this repository's CLAUDE.md that passes on what an automated build loop learned here, so ` +
    `people and fresh Claude sessions working in the repo get it. Use the project brief and the lessons below; keep what ` +
    `holds for the code as it is now (check the repository if unsure): stack and layout, conventions, how to build and ` +
    `test, pitfalls. Leave out one-off failures, and anything the rest of CLAUDE.md already says.\n` +
    (brief ? `\nProject brief:\n${brief}\n` : "") +
    (notes ? `\nLessons from earlier goals:\n${notes.slice(-6000)}\n` : "") +
    (current
      ? `\nThe current CLAUDE.md${ours ? " (the part between the yaaiorch markers is the earlier version of this section)" : ""}:\n${current.slice(0, 8000)}\n`
      : "") +
    SHARE_FORMAT;
  emit("share_start", {});
  let ok = false;
  let branch: string | undefined;
  try {
    const r = await run(architect, modelFor(o.power, o.models, "architect", "architect"), prompt, ctx, true);
    const { section } = extractJson<{ section?: unknown }>(r.text);
    if (typeof section !== "string" || section.trim().length < 20) throw new Error("the architect returned no section");
    const next = withSharedSection(current, section);
    if (o.dryRun) console.log(`\n${next.slice(next.indexOf(SHARE_START))}`);
    else {
      branch = `${BRANCH_PREFIX}claude-md-${Date.now()}`;
      commitOnSideBranch(branch, "CLAUDE.md", next, "docs: what YAAIORCH learned about this repo (CLAUDE.md)");
      console.log(`\nProposed on branch ${branch} (your working tree is unchanged).\n  review: git diff HEAD ${branch}\n  take it: git merge ${branch}`);
    }
    ok = true;
  } finally {
    emit("share_end", { ok, branch, cost: round4(ctx.budget.spent), ...(ctx.budget.tokens ? { tokens: ctx.budget.tokens } : {}) });
    console.log(`cost: ${usd(ctx.budget.spent)}`);
  }
}

/** Brief and recent lessons for implementers, QA and the critic, so they need not explore the repo from scratch. */
function repoContext(brief: string, notes: string): string {
  return (
    (brief ? `## Project brief (notes on this repo from earlier runs; use it instead of exploring from scratch)\n${brief}\n\n` : "") +
    (notes ? `## Lessons from earlier goals in this repo\n${notes.slice(-1500)}\n\n` : "")
  );
}

const readNotes = (): string => (existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, "utf8").trim().slice(-4000) : "");

/**
 * After a goal, append what is worth remembering: QA's notes, the first failures of a goal that needed
 * more than one round, and what was left unresolved by a failed goal. Nothing for a clean one-round pass.
 */
function appendNotes(goal: string, passed: boolean, rounds: number, qaNotes: string[], firstFailures: string[], lastFailures: string[]) {
  const cut = (f: string) => f.replace(/\s+/g, " ").trim().slice(0, 200);
  const lines = [
    ...[...new Set(qaNotes)].map((n) => `- ${cut(n)}`),
    ...(rounds > 1 ? firstFailures.slice(0, 2).map((f) => `- Pitfall (round 1 failed on): ${cut(f)}`) : []),
    ...(!passed ? lastFailures.slice(0, 3).map((f) => `- Unresolved: ${cut(f)}`) : []),
  ];
  if (!lines.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const entry = `## ${day} · ${passed ? "passed" : "failed"} in ${rounds} round(s) · ${short(goal)}\n${lines.join("\n")}\n`;
  let all = (existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, "utf8").trim() + "\n\n" : NOTES_HEAD) + entry;
  while (all.length > MAX_NOTES) {
    const i = all.indexOf("\n## ", all.indexOf("## ") + 3); // drop the oldest entry, keep the heading
    if (i < 0) break;
    all = all.slice(0, all.indexOf("## ")) + all.slice(i + 1);
  }
  writeFileAtomic(NOTES_FILE, all);
}

/**
 * Merge duplicate lessons and drop ones that no longer apply, once notes.md is past TIDY_AT. One cheap read-only call
 * (the implementers' model); any failure keeps the notes as they are. Returns the cost.
 */
async function tidyNotes(architect: Entry, o: Opts, ctx: RunCtx): Promise<number> {
  const before = existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, "utf8") : "";
  if (before.length <= TIDY_AT) return 0;
  const spent = ctx.budget.spent;
  const tokensBefore = ctx.budget.tokens;
  let after = before.length;
  let ok = false;
  try {
    const prompt =
      `Tidy these lessons that earlier goals in this repository left for later ones. Merge duplicates and lessons that say ` +
      `the same thing; drop lessons about one-off failures that were fixed, and ones that no longer apply to the code ` +
      `(look at the repository if you are not sure). Keep pitfalls, decisions and conventions a later goal needs to know, ` +
      `each as one short line. At most 25 lessons.\n\nLessons:\n${before}` +
      TIDY_FORMAT;
    const r = await run(architect, modelFor(o.power, o.models, "impl"), prompt, ctx, true);
    const { notes } = extractJson<{ notes?: unknown }>(r.text);
    if (typeof notes !== "string" || !notes.trim()) throw new Error("no notes in the reply");
    const day = new Date().toISOString().slice(0, 10);
    const text = `${NOTES_HEAD}## ${day} · tidied\n${notes.trim()}\n`;
    if (text.length >= before.length) throw new Error("the tidied notes are not shorter");
    writeFileAtomic(NOTES_FILE, text);
    after = text.length;
    ok = true;
    console.log(`notes.md tidied: ${before.length} -> ${after} characters`);
  } catch (e) {
    console.warn(`could not tidy notes.md (${msg(e)}); kept as it is`);
  }
  const cost = ctx.budget.spent - spent;
  const tokens = tokenUsageDelta(ctx.budget.tokens, tokensBefore);
  emit("notes_tidy", { ok, before: before.length, after, cost: round4(cost), ...(tokens ? { tokens } : {}) });
  return cost;
}

/** A diff review: the critic against the goal, or a reviewer for bugs and security. Non-fatal errors approve. */
type Lens = "goal" | "bugs";
const LENS: Record<Lens, string> = {
  goal:
    "Review this change against the goal: does it do everything the goal asks, wired in where it must be (exports, routes, " +
    "registration, config), with tests for the new behaviour? Reject only for gaps that mean the goal is not met.",
  bugs:
    "Review this change for bugs and security problems (logic errors, unhandled edge cases and errors, broken contracts " +
    "between files, injection, missing authorization, secrets, unsafe input handling). Reject only for real defects, not style.",
};
async function reviewDiff(
  agent: Entry,
  lens: Lens,
  goal: string,
  cp: string,
  model: string,
  ctx: RunCtx,
): Promise<Review & { cost: number; tokens?: TokenUsage }> {
  const patch = cp ? execFileSync("git", ["diff", cp, "--", ".", NOT_STATE], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }) : "";
  const prompt =
    `${ctx.repoContext ?? ""}Goal: ${goal}\n\n${LENS[lens]}\n\n` +
    (cp ? `Changed files:\n${diffSummary(cp)}\n\n` : "") +
    (patch
      ? `The change${patch.length > 30_000 ? ` (first 30,000 characters; run "git diff ${cp}" for the rest)` : ""}:\n${patch.slice(0, 30_000)}`
      : "Read the changed files to review the change.") +
    REVIEW_FORMAT;
  try {
    const r = await run(agent, model, prompt, ctx, true);
    return { ...asReview(extractJson<Review>(r.text)), cost: r.cost, tokens: r.tokens };
  } catch (e) {
    if (isFatal(e)) throw e;
    console.warn(`${agent.name} could not review the change (${msg(e)}); going on without it`);
    return { approved: true, issues: [], cost: 0 };
  }
}

/** The plan critic: a read-only review of the plan before anything is built. Non-fatal errors approve the plan. */
async function critique(
  critic: Entry,
  goal: string,
  plan: Plan,
  brief: string | null,
  model: string,
  ctx: RunCtx,
): Promise<Review & { cost: number; tokens?: TokenUsage }> {
  const prompt =
    `Goal: ${goal}\n\n` +
    (brief ? `Project brief:\n${brief}\n\n` : "") +
    `Plan to review:\n${JSON.stringify({ summary: plan.summary, tasks: plan.tasks }, null, 2)}` +
    REVIEW_FORMAT;
  try {
    const r = await run(critic, model, prompt, ctx, true);
    return { ...asReview(extractJson<Review>(r.text)), cost: r.cost, tokens: r.tokens };
  } catch (e) {
    if (isFatal(e)) throw e;
    console.warn(`plan critic failed (${msg(e)}); going on with the plan`);
    return { approved: true, issues: [], cost: 0 };
  }
}

// ---------- big briefs: orch split (an existing repo) and orch new (an empty folder) ----------
/** The whole brief a queue was split from; every goal's architect reads it (MAX_SPEC_PROMPT of it). */
const SPEC_FILE = join(DIR, "spec.md");
/** Coverage passes per brief, and which goals they have seen (see coverageCheck). */
const SPEC_STATE = join(DIR, "spec-state.json");
const MAX_SPEC = 100_000;
const MAX_SPEC_PROMPT = 15_000;
const MAX_GOALS = 30;
const COVERAGE_PASSES = 2;

const GOALS_FORMAT = `

## Reply format
Do not create or edit any file. Reply with exactly one JSON object and nothing else:
{"goals": [{"goal": "<goal 1>", "after": []}, {"goal": "<goal 2>", "after": [1]}, ...], "checks": {"<name>": "<shell command>"}}
"after" lists the numbers (1 = the first goal) of the earlier goals this one needs: if one of them fails, this one is
not run. Use [] for a goal that needs none of them. "checks" only for a new project; leave it out otherwise.`;

const readSpec = (): string => (existsSync(SPEC_FILE) ? readFileSync(SPEC_FILE, "utf8").trim() : "");

/** The spec as the architect of one goal sees it: the start and, for a long one, a note that it goes on. */
function specForPrompt(): string {
  const spec = readSpec();
  if (!spec) return "";
  const cut = spec.length > MAX_SPEC_PROMPT;
  return (
    `\nThe user's brief this goal is part of (build only this goal, but keep the rest in mind so its design fits what comes later` +
    `${cut ? `; the brief is cut here, the whole of it is in ${SPEC_FILE}` : ""}):\n${spec.slice(0, MAX_SPEC_PROMPT)}\n`
  );
}

/** A goal from a split: `after` holds 1-based positions of earlier goals it needs; null: not said (all earlier ones). */
type SplitGoal = { goal: string; after: number[] | null };

/** Goals from a splitter reply or a UI: strings or {goal, after}, at most MAX_GOALS, each at most 3000 characters. */
function asGoals(v: unknown): SplitGoal[] {
  if (!Array.isArray(v)) return [];
  const out: SplitGoal[] = [];
  for (const g of v) {
    const text =
      typeof g === "string" ? g : g && typeof g === "object" && typeof (g as { goal?: unknown }).goal === "string" ? (g as { goal: string }).goal : "";
    if (!text.trim()) continue;
    const raw = typeof g === "object" && g ? (g as { after?: unknown }).after : undefined;
    const after = Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n)) : null;
    out.push({ goal: text.trim().slice(0, 3000), after });
  }
  return out.slice(0, MAX_GOALS);
}

/** The earlier positions (1-based) goal `i` (0-based) needs: what was said, kept to earlier goals; else all earlier ones. */
const needs = (g: SplitGoal, i: number) =>
  g.after === null ? Array.from({ length: i }, (_, j) => j + 1) : [...new Set(g.after.filter((n) => n >= 1 && n <= i))];

/**
 * One read-only architect call that splits a brief into goals in build order. `fresh`: an empty project, whose first
 * goal sets it up and which also gets suggested checks. Emits `split_proposal` (goals, checks, cost).
 */
async function splitBrief(brief: string, o: Opts, fresh: boolean, setup?: string, proposeOnly = false) {
  const roster = discoverAgents();
  const architect = roster.find((a) => a.name === "architect")!;
  writeBuiltins(roster);
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  writeAgentSettings(cfg, loadChecks(cfg), o.plugins);
  const ctx: RunCtx = {
    budget: { spent: 0, cap: o.maxCost, reserved: 0, launching: 0 },
    timeoutMs: o.agentTimeoutMs,
    usageCap: o.usageCap,
    onLimit: o.onLimit,
  };
  const prompt =
    `${fresh ? "A new project" : "This repository"} is to be built ${fresh ? "from" : "further according to"} the brief below by an ` +
    `automated loop: each goal is planned by an architect, built by agents in parallel, then verified by running the ` +
    `project's checks and by QA. Split the brief into goals, in the order they should be built:\n` +
    (fresh
      ? `- Goal 1 sets up the project: the manifest with its dependencies (${setup ? `the orchestrator installs them with \`${setup}\`` : "prefer none: nothing will install them"}), ` +
        `the folder layout, a test runner with one passing test, the scripts or commands the checks use, and a README.\n`
      : `- Read the repository first where you need to (README, layout, the code the brief touches), so the goals fit what exists ` +
        `and skip what is already done.\n`) +
    `- Each goal is one feature or slice, small enough for one plan of at most 10 tasks, and says what to build, where, and ` +
    `how it is tested. A goal may build on earlier ones, never on later ones.\n` +
    `- Each goal must make sense on its own: its agents see that goal, the brief and the code. Begin it with the part of the ` +
    `brief it covers in brackets, e.g. "[Auth] Add ...".\n- Cover the whole brief, in at most ${MAX_GOALS} goals.\n` +
    (fresh
      ? `Also suggest "checks": the shell commands the orchestrator runs after every build to judge it (tests, then typecheck or ` +
        `lint if the stack has them), at most 4, each using only what goal 1 sets up.\n`
      : "") +
    `\nBrief:\n${brief.slice(0, MAX_SPEC)}` +
    GOALS_FORMAT;
  const r = await run(architect, modelFor(o.power, o.models, "architect", "architect"), prompt, ctx, true);
  const reply = extractJson<{ goals?: unknown; checks?: unknown }>(r.text);
  const goals = asGoals(reply.goals);
  if (!goals.length) throw new Error("the architect returned no goals");
  const checks = Object.fromEntries(
    Object.entries(fresh && reply.checks && typeof reply.checks === "object" ? (reply.checks as Record<string, unknown>) : {})
      .filter(([n, c]) => /^[\w-]{1,30}$/.test(n) && typeof c === "string" && c.trim() && c.length < 300)
      .slice(0, 4) as [string, string][],
  );
  // `queued`: the goals are queued right away (not --propose), so a UI must not offer to queue them again.
  emit("split_proposal", {
    goals: goals.map((g) => g.goal),
    after: goals.map(needs),
    ...(fresh ? { checks } : {}),
    queued: !proposeOnly,
    cost: round4(ctx.budget.spent),
  });
  return { goals, checks, cost: ctx.budget.spent };
}

/** A name for a brief: when it was queued and its first words (its goals share the branch orch/brief-<this>). */
function briefId(brief: string): string {
  const slug =
    brief
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "brief";
  return `${Date.now().toString(36)}-${slug}`;
}

/**
 * Keep the brief and queue its goals, marked as coming from it (for the coverage check and the shared branch), each
 * with the queue ids of the earlier goals it needs. Returns their ids.
 */
function acceptSplit(brief: string, goals: SplitGoal[]): number[] {
  if (!brief.trim()) throw new Error("the brief is empty");
  if (!goals.length) throw new Error("no goals to queue");
  mkdirSync(DIR, { recursive: true });
  const id = briefId(brief);
  writeFileAtomic(SPEC_FILE, brief.trim().slice(0, MAX_SPEC) + "\n");
  writeFileAtomic(SPEC_STATE, JSON.stringify({ passes: 0, checkedUpTo: 0, brief: id }));
  const ids = updateQueue((q) => {
    const made: number[] = [];
    goals.forEach((g, i) => {
      const n = Math.max(0, ...q.map((x) => x.id)) + 1;
      q.push({ id: n, goal: g.goal, status: "pending", fromSpec: true, brief: id, after: needs(g, i).map((pos) => made[pos - 1]) });
      made.push(n);
    });
    return made;
  });
  const deps = (i: number) =>
    needs(goals[i], i).length
      ? ` (after ${needs(goals[i], i)
          .map((pos) => `#${ids[pos - 1]}`)
          .join(", ")})`
      : "";
  console.log(`queued ${ids.length} goal(s) from the brief (kept in ${SPEC_FILE}):\n${goals.map((g, i) => `  #${ids[i]} ${g.goal}${deps(i)}`).join("\n")}`);
  return ids;
}

/** A brief from --brief-file (deleted afterwards with --brief-file-temp, as the UI's backends pass it) or the words. */
function briefFrom(values: Record<string, string | boolean | undefined>, words: string[]): string {
  const file = values["brief-file"] ?? values["spec-file"];
  if (!file) return words.join(" ");
  const text = readFileSync(String(file), "utf8");
  if (values["brief-file-temp"]) rmSync(String(file), { force: true });
  return text;
}

/**
 * `orch split "<brief>"`: split a big brief into queued goals for this repo. `--propose` only shows the split (the UI
 * edits it); `--accept` queues goals given on stdin as {brief, goals}; neither: both at once. `--start` then runs the
 * loop until the queue is empty.
 */
async function split(values: Record<string, string | boolean | undefined>, words: string[]) {
  const o = { ...parseOpts(values), park: true };
  if (values.accept) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { brief?: unknown; goals?: unknown };
    const goals = asGoals(input.goals);
    acquireRunLock("split");
    acceptSplit(typeof input.brief === "string" ? input.brief : "", goals);
  } else {
    const brief = briefFrom(values, words);
    if (!brief.trim()) throw new Error('usage: orch split "<brief>"  (or --brief-file FILE)');
    acquireRunLock("split");
    console.log("asking the architect to split the brief into goals...");
    const { goals, cost } = await splitBrief(brief, o, false, undefined, !!values.propose);
    console.log(`cost: ${usd(cost)}`);
    if (values.propose) return console.log(`\nproposed ${goals.length} goal(s):\n${goals.map((g, i) => `  ${i + 1}. ${g.goal}`).join("\n")}`);
    acceptSplit(brief, goals);
  }
  if (values.start) return loop(o, Number(values.poll), true);
  console.log(`\nReview the queue ("orch status"), then: orch loop --until-empty`);
}

/** Ignored from the first commit: orch's state and the usual dependency and build folders. */
const NEW_GITIGNORE = [".orchestrator/", "node_modules/", ".venv/", "venv/", "__pycache__/", "dist/", "build/", "target/", ".env", ""].join("\n");

/**
 * `orch new DIR "<spec>"`: a git repo in a new or empty folder with SPEC.md and a .gitignore, then the spec split into
 * queued goals (the scaffold first) with suggested checks for .orchestrator/config.json. With --start the loop runs.
 */
async function newProject(dir: string, spec: string, o: Opts, setup: string | undefined, start: boolean, poll: number) {
  if (!spec.trim()) throw new Error('usage: orch new DIR "<spec>"  (or --spec-file FILE)');
  const target = resolve(dir);
  // Only .orchestrator (a UI's doctor or plugin check may create it) counts as empty too.
  if (existsSync(target) && readdirSync(target).some((f) => f !== ".orchestrator"))
    throw new Error(`${target} is not empty; orch new starts a project in a new or empty folder`);
  mkdirSync(target, { recursive: true });
  process.chdir(target);
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync("SPEC.md", `# Spec\n\n${spec.trim()}\n`);
  writeFileSync(".gitignore", NEW_GITIGNORE);
  commitAll("orch: new project (spec)");
  acquireRunLock("new");
  writeBrief(
    `This is a new project, built by an automated loop from the spec in SPEC.md; the first goal sets it up. ` +
      `Until the scaffold exists there is nothing else to read.`,
    true,
  );
  if (setup) writeFileAtomic(CONFIG_FILE, JSON.stringify({ setup }, null, 2));
  console.log(`project created at ${target}; asking the architect to split the spec into goals...`);
  const { goals, checks, cost } = await splitBrief(spec, o, true, setup);
  writeFileAtomic(CONFIG_FILE, JSON.stringify({ ...(Object.keys(checks).length ? { checks } : {}), ...(setup ? { setup } : {}) }, null, 2));
  acceptSplit(spec, goals);
  console.log(
    `\nchecks (${CONFIG_FILE}): ${
      Object.entries(checks)
        .map(([n, c]) => `${n}: ${c}`)
        .join(", ") || "none suggested"
    }` +
      (setup ? `\nsetup: ${setup} (runs before the checks whenever a manifest changes)` : "") +
      `\ncost: ${usd(cost)}`,
  );
  if (start) return loop({ ...o, park: true }, poll, true);
  console.log(`\nReview them, then: cd "${target}" && orch loop --until-empty`);
}

/**
 * After the queue runs dry: compare the brief with the code once more and queue what is still missing (at most 5
 * goals, at most COVERAGE_PASSES times per brief, and only after new goals from it have finished). Returns its cost,
 * or -1 when nothing was queued.
 */
async function coverageCheck(o: Opts): Promise<{ queued: number; cost: number }> {
  const spec = readSpec();
  if (!spec) return { queued: 0, cost: 0 };
  const state = readJsonFile<{ passes?: number; checkedUpTo?: number; brief?: string; pr?: string }>(SPEC_STATE, {});
  const passes = state.passes ?? 0;
  const q = readQueue();
  const mine = q.filter((i) => i.fromSpec);
  const last = Math.max(0, ...mine.map((i) => i.id));
  if (
    passes >= COVERAGE_PASSES ||
    !mine.length ||
    last <= (state.checkedUpTo ?? 0) ||
    mine.some((i) => i.status === "pending" || i.status === "running" || i.status === "blocked")
  )
    return { queued: 0, cost: 0 };
  const roster = discoverAgents();
  const architect = roster.find((a) => a.name === "architect")!;
  writeBuiltins(roster);
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  writeAgentSettings(cfg, loadChecks(cfg), o.plugins);
  const ctx: RunCtx = {
    budget: { spent: 0, cap: o.maxCost, reserved: 0, launching: 0 },
    timeoutMs: o.agentTimeoutMs,
    usageCap: o.usageCap,
    onLimit: o.onLimit,
  };
  let missing: string[] = [];
  try {
    const prompt =
      `The goals below were run to build what the brief asks. Read the repository and list what the brief asks that is not ` +
      `done yet (missing, or clearly broken), as at most 5 new goals in the same style. Ignore polish the brief does not ask for. ` +
      `An empty list means the brief is covered.\n\nGoals run:\n${mine.map((i) => `- [${i.status}] ${i.goal.slice(0, 300)}`).join("\n")}\n\n` +
      `Brief:\n${spec.slice(0, MAX_SPEC)}` +
      GOALS_FORMAT;
    const r = await run(architect, modelFor(o.power, o.models, "architect", "architect"), prompt, ctx, true);
    missing = asGoals(extractJson<{ goals?: unknown }>(r.text).goals)
      .slice(0, 5)
      .map((g) => g.goal);
  } catch (e) {
    if (isFatal(e)) throw e;
    console.warn(`coverage check failed (${msg(e)}); not checked`);
  }
  writeFileAtomic(SPEC_STATE, JSON.stringify({ ...state, passes: passes + 1, checkedUpTo: last }));
  emit("coverage", {
    pass: passes + 1,
    missing,
    cost: round4(ctx.budget.spent),
    ...(ctx.budget.tokens ? { tokens: ctx.budget.tokens } : {}),
  });
  if (!missing.length) console.log("coverage check: the brief looks covered");
  else
    updateQueue((qq) => {
      for (const goal of missing) qq.push({ id: Math.max(0, ...qq.map((i) => i.id)) + 1, goal, status: "pending", fromSpec: true, brief: state.brief });
    });
  if (missing.length) console.log(`coverage check: queued ${missing.length} goal(s) for what is missing:\n- ${missing.join("\n- ")}`);
  return { queued: missing.length, cost: ctx.budget.spent };
}

// ---------- --approve-plan: a human approves, edits or rejects each plan ----------
type Decision = { round: number; action: "approve" | "reject"; plan?: Plan; note?: string };
/** Agents that may get tasks, as `orch approve` sees them (it cannot know a run's --reviewers; the run checks again). */
const taskAgents = (roster: Entry[], extra: string[] = []) => roster.filter((a) => !["architect", "critic", "reviewer", ...extra].includes(a.name));

/** Show the plan and wait (without a time limit) for `orch approve`. `error`: why the previous answer was not usable. */
async function awaitDecision(goal: string, round: number, plan: Plan, error?: string): Promise<Decision> {
  if (existsSync(PLAN_DECISION)) unlinkSync(PLAN_DECISION); // an answer left over from an earlier run
  writeFileAtomic(PLAN_PENDING, JSON.stringify({ goal, round, plan }, null, 2));
  emit("approval_wait", { round, summary: plan.summary, tasks: plan.tasks.map((t, id) => ({ id, ...t })), ...(error ? { error } : {}) });
  console.log(
    `\nwaiting for your approval of the round ${round} plan${error ? ` (${error})` : ""}.\n` +
      `  build it: orch approve   edit it: change ${PLAN_PENDING}, then orch approve --plan-stdin < ${PLAN_PENDING}\n` +
      `  send it back: orch approve --reject "why"   (or use the UI)`,
  );
  for (;;) {
    if (existsSync(PLAN_DECISION)) {
      let d: Decision | undefined;
      try {
        d = JSON.parse(readFileSync(PLAN_DECISION, "utf8")) as Decision;
      } catch {
        /* being written; try again */
      }
      if (d) {
        unlinkSync(PLAN_DECISION);
        if (d.round === round) {
          if (existsSync(PLAN_PENDING)) unlinkSync(PLAN_PENDING);
          emit("approval", { round, action: d.action, edited: !!d.plan });
          return d;
        }
      }
    }
    await sleep(500);
  }
}

/** `orch approve`: answer the waiting plan. Checks an edited plan here, so a mistake is reported at once. */
function approve(values: Record<string, string | boolean | undefined>) {
  if (!existsSync(PLAN_PENDING)) throw new Error("no plan is waiting for approval in this repo");
  const pending = JSON.parse(readFileSync(PLAN_PENDING, "utf8")) as { round: number };
  const d: Decision = { round: pending.round, action: values.reject !== undefined ? "reject" : "approve" };
  if (d.action === "reject") d.note = String(values.reject).trim().slice(0, 4000);
  else if (values["plan-stdin"]) {
    const plan = extractJson<Plan>(readFileSync(0, "utf8"));
    validate(plan, taskAgents(discoverAgents()));
    d.plan = plan;
  }
  writeFileAtomic(PLAN_DECISION, JSON.stringify(d));
  console.log(d.action === "reject" ? "plan sent back to the architect" : `plan approved${d.plan ? " (edited)" : ""}`);
}

/** What a round planned, how each task ended and what changed: the next round's architect builds on it. */
function previousRound(round: number, plan: Plan, statuses: Map<Task, string>, cp: string): string {
  const tasks = plan.tasks
    .map(
      (t) =>
        `- [${t.phase}] ${t.agent} -> ${statuses.get(t) ?? "not run"}: ${t.task.replace(/\s+/g, " ").slice(0, 200)}${t.files?.length ? ` (files: ${t.files.join(", ")})` : ""}`,
    )
    .join("\n");
  const diff = cp ? diffSummary(cp) : "";
  return (
    `What round ${round} did (keep what is right, fix what is not; do not redo finished work):\n` +
    `Plan: ${plan.summary}\n${tasks}` +
    (diff ? `\nChanges since the start of the goal (committed):\n${diff.slice(0, 3000)}` : "")
  );
}
const writeLastRun = (lr: LastRun) => writeFileAtomic(LAST_RUN, JSON.stringify(lr, null, 2));

// ---------- one goal: architect -> foundation -> build (parallel) -> verify, repeat ----------
/** What the last runGoal() spent, also when it ended with an error (for --max-cost-total). */
let lastGoalCost = 0;
/** QA's notes for the goal being run, written to notes.md when it ends. */
let goalNotes: string[] = [];
async function runGoal(goal: string, o: Opts, id?: number, brief?: string, resumeFrom?: string, issue?: number): Promise<boolean> {
  emit("goal_start", {
    goal,
    maxRounds: o.maxRounds,
    dryRun: o.dryRun,
    power: o.power,
    maxCost: o.maxCost,
    models: o.models,
    onLimit: o.onLimit,
    usageCap: o.usageCap,
    plugins: o.plugins,
    critic: o.critic,
    approvePlan: o.approvePlan,
    branch: o.branch,
    pr: o.pr,
  });
  const ctx: RunCtx = {
    budget: { spent: 0, cap: o.maxCost, reserved: 0, launching: 0 },
    timeoutMs: o.agentTimeoutMs,
    usageCap: o.usageCap,
    onLimit: o.onLimit,
  };
  const lr: LastRun = { goal, status: "running", cost: 0, state: [], ...(issue ? { issue } : {}) };
  goalNotes = [];
  let cp = "";
  let gb: GoalBranch | undefined;
  lastParked = undefined;
  let passed = false;
  let interrupted = false;
  try {
    // With --branch the checkpoint is taken on the goal's branch (a brief's shared branch may be ahead of the base).
    cp = o.dryRun
      ? ""
      : prepareGit(() => {
          if (!o.branch) return;
          gb = startGoalBranch(goal, id, brief);
          lr.branch = gb.branch;
          lr.base = gb.base;
        });
    lr.checkpoint = cp || undefined;
    if (!o.dryRun) writeLastRun(lr); // the UI offers rollback from this even if the run is killed in round 1
    // An attempt cut short by the usage limit left its work on a branch: carry on from it instead of redoing it.
    const resumed = cp && resumeFrom ? applyParked(resumeFrom) : null;
    passed = await runGoalInner(goal, o, cp, ctx, lr, resumed);
    if (o.notes && !o.dryRun) {
      const rounds = lr.state as { failures: string[] }[];
      appendNotes(goal, passed, rounds.length, goalNotes, rounds[0]?.failures ?? [], rounds.at(-1)?.failures ?? []);
      await tidyNotes(
        discoverAgents().find((a) => a.name === "architect")!,
        o,
        ctx,
      );
    }
    emit("goal_end", { passed, cost: round4(ctx.budget.spent), ...(ctx.budget.tokens ? { tokens: ctx.budget.tokens } : {}) });
    return passed;
  } catch (e) {
    if (e instanceof UsageLimit) {
      interrupted = true;
      emit("usage_limit", { message: e.message, resetAt: e.resetAt });
    }
    emit("goal_end", {
      passed: false,
      error: msg(e),
      cost: round4(ctx.budget.spent),
      ...(ctx.budget.tokens ? { tokens: ctx.budget.tokens } : {}),
      ...(e instanceof UsageLimit ? { usageLimit: true, resetAt: e.resetAt } : {}),
    });
    throw e;
  } finally {
    lastGoalCost = ctx.budget.spent;
    if (cp && gb) finishGoalBranch(cp, gb, goal, passed, o, lr, interrupted);
    else if (cp) finishGit(cp, goal, passed, o.park || (interrupted && o.onLimit === "wait"), interrupted);
    console.log(`cost: ${usd(ctx.budget.spent)}${o.maxCost !== undefined ? ` of ${usd(o.maxCost)}` : ""}`);
    if (!o.dryRun) {
      lr.status = passed ? "passed" : "failed";
      lr.cost = round4(ctx.budget.spent);
      lr.tokens = ctx.budget.tokens;
      lr.checkpoint = cp && branchExists(cp) ? cp : undefined;
      writeLastRun(lr);
    }
    // --pr: the pull request is open (or updated); see its CI through, fixing it if it fails.
    if (passed && gb && o.pr && lr.pr && o.ciFixes >= 0 && !o.dryRun) {
      lastGoalCost += await watchPullRequest(gb, goal, o, lr);
      writeLastRun(lr);
    }
  }
}

/** Browser checks for this goal: the dev server and the browser, or null when they are off or cannot run. */
function visualSetup(cfg: Config, o: Opts): { serve: ServeConfig; exe: string } | null {
  VISUAL_HINT = "";
  if (!cfg.serve || !o.visual) return null;
  const serve = parseServe(cfg.serve);
  if (!hasWebSocket()) {
    console.warn("browser checks off: they need Node.js 22 or newer");
    return null;
  }
  const b = findBrowser();
  if (!b) {
    console.warn('browser checks off: no Chrome, Edge, Chromium or Brave found; run "orch browser install" or set YAAIORCH_BROWSER');
    return null;
  }
  if (!DEV_SERVER || JSON.stringify(DEV_SERVER.cfg) !== JSON.stringify(serve)) {
    DEV_SERVER?.stop();
    const server = new DevServer(serve);
    process.on("exit", () => server.stop());
    DEV_SERVER = server;
  }
  rmSync(VISUAL_DIR, { recursive: true, force: true });
  VISUAL_HINT =
    `\n## Browser checks\nAfter the checks, the orchestrator can open the app (${serve.url}) in a real browser before QA. When the goal ` +
    `changes what users see, give the verify task a "visual" list; QA then gets screenshots of those pages and what the browser ` +
    `measured (page errors, console errors, failed requests, horizontal overflow), and a page that does not render fails the round:\n` +
    `"visual": [{"path": "/route/in/the/app", "selector": "<CSS selector of the changed part; optional>", "actions": [{"click": "<selector>"}, ` +
    `{"wait": "<selector> or milliseconds"}], "viewports": [1280, 375], "themes": ["light", "dark"]}]\n` +
    `At most ${MAX_TARGETS} pages in all. Actions only reach the state to check (a tab, a menu, a dialog): never submit forms or change ` +
    `data. Leave "visual" out when users cannot see the change.\n`;
  console.log(`browser checks: ${serve.url}${serve.command ? ` (started with \`${serve.command}\` when needed)` : ""}, browser ${b.path}`);
  return { serve, exe: b.path };
}

async function runGoalInner(goal: string, o: Opts, cp: string, ctx: RunCtx, lr: LastRun, resumed: string[] | null = null, title?: string): Promise<boolean> {
  PROTECT = o.protect;
  SECRET_SCAN = o.secretScan;
  const roster = discoverAgents();
  const byName = new Map(roster.map((a) => [a.name, a]));
  const architect = byName.get("architect")!; // always present: built-in unless overridden
  // The critic and the reviewers review; they are never given build or verify tasks.
  const reviewerNames = o.review === null ? [] : o.review.length ? o.review : ["reviewer"];
  for (const n of reviewerNames) if (!byName.has(n)) throw new Error(`reviewer "${n}" is not an agent (known: ${[...byName.keys()].join(", ")})`);
  const workers = roster.filter((a) => !["architect", "critic", "reviewer", ...reviewerNames].includes(a.name));
  const critic = byName.get("critic");
  /** Diff reviews each round runs next to QA: the critic against the goal, the reviewers for bugs and security. */
  const diffReviewers: { agent: Entry; lens: Lens }[] = [
    ...(o.diffCritic && critic ? [{ agent: critic, lens: "goal" as Lens }] : []),
    ...reviewerNames.map((n) => ({ agent: byName.get(n)!, lens: "bugs" as Lens })),
  ];
  const skills = discoverSkills();
  writeBuiltins(roster);
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  let checks = loadChecks(cfg);
  writeAgentSettings(cfg, checks, o.plugins);
  const browserCheck = visualSetup(cfg, o);
  /** Checks come from package.json too, which the agents may create or change: read them again each round. */
  const refreshChecks = () => {
    const next = loadChecks(cfg);
    if (JSON.stringify(next) === JSON.stringify(checks)) return;
    checks = next;
    writeAgentSettings(cfg, checks, o.plugins);
    console.log(
      `checks now: ${
        Object.entries(checks)
          .map(([n, c]) => `${n} (${c})`)
          .join(", ") || "none"
      }`,
    );
  };
  if (o.plugins.off || o.plugins.disable.length || !o.plugins.hooks)
    console.log(
      `plugins: ${o.plugins.off ? "all off" : o.plugins.disable.length ? `off: ${o.plugins.disable.join(", ")}` : "on"}${o.plugins.hooks ? "" : "; hooks off"}`,
    );
  console.log(
    `checks: ${
      Object.entries(checks)
        .map(([n, c]) => `${n} (${c})`)
        .join(", ") || "none configured"
    }`,
  );

  let power = o.power;
  let models = o.models;
  for (const agent of Object.keys(models.agents))
    if (!byName.has(agent)) throw new Error(`model override for unknown agent "${agent}" (known: ${[...byName.keys()].join(", ")})`);
  let failures: string[] = [];
  let note = resumed?.length
    ? `An earlier attempt at this goal was cut short by the Claude usage limit, not by a failure. Its work is already ` +
      `committed here:\n- ${resumed.join("\n- ")}\nRead what it did (the code and the tests) and plan only what remains. ` +
      `If it looks complete, plan just the verify task.`
    : "";
  let stuck = 0;
  let previous = "";
  /** Per-task escalation: agents moved up on their own after a stuck round (tier, and models with aliases stepped up). */
  const agentPower = new Map<string, Power>();
  const agentModels = new Map<string, Models>();
  /** Implementer sessions from the round before, continued by the next round's tasks (empty after a stuck round). */
  let sessions: Session[] = [];
  ctx.resume = o.resume;

  for (let round = 1; round <= o.maxRounds; round++) {
    const spentBefore = ctx.budget.spent;
    const tokensBefore = ctx.budget.tokens;
    const roundBase = cp ? git("rev-parse", "HEAD") : "";
    const dirtyAtStart = cp ? !!dirtyFiles() : false;
    // Fast path: the first round skips the architect; one generalist agent does the whole goal.
    const direct = o.fast && round === 1 && byName.has("dev");
    console.log(`\n=== round ${round}/${o.maxRounds} (${power}${direct ? ", direct attempt" : ""}) ===`);
    emit("round_start", {
      round,
      power,
      models: effectiveModels(power, models),
      ...(direct ? { mode: "direct" } : {}),
      ...(agentPower.size ? { agentPower: Object.fromEntries(agentPower) } : {}),
    });
    let plan: Plan;
    let planCost = 0;
    // The brief is checked for staleness once per goal (round 1); later rounds use what is on disk.
    const fresh = o.brief ? (round === 1 ? briefForGoal() : { text: readBrief(), stale: false }) : null;
    const brief = fresh ? fresh.text : null;
    const notes = o.notes ? readNotes() : "";
    const planTokensBefore = ctx.budget.tokens;
    if (direct) plan = directPlan(goal, checks, brief || null, notes);
    else {
      emit("architect_start", { round });
      const architectModel = modelFor(power, models, "architect", "architect");
      ({ plan, cost: planCost } = await makePlan(architect, workers, skills, goal, failures, note, architectModel, ctx, previous, brief, notes));
      if (o.brief && plan.brief) writeBrief(plan.brief);
      else if (fresh?.stale) writeBrief(readBrief(), true); // checked and still right: re-stamp it at this commit
      if (o.critic && critic) {
        // The critic sees only the goal, the brief and the plan, never the architect's reasoning.
        const review = await critique(critic, goal, plan, brief || null, modelFor(power, models, "qa", "critic"), ctx);
        planCost += review.cost;
        let revised = false;
        if (!review.approved) {
          console.warn(`plan critic rejected the plan:\n- ${review.issues.join("\n- ")}`);
          const why = `A reviewer rejected your plan for this round:\n- ${review.issues.join("\n- ")}\nRevise the plan to fix these.`;
          const again = await makePlan(
            architect,
            workers,
            skills,
            goal,
            failures,
            [note, why].filter(Boolean).join("\n\n"),
            architectModel,
            ctx,
            previous,
            brief,
            notes,
          );
          plan = again.plan;
          planCost += again.cost;
          revised = true;
        }
        emit("critic", {
          round,
          approved: review.approved,
          issues: review.issues,
          revised,
          cost: round4(review.cost),
          ...(review.tokens ? { tokens: review.tokens } : {}),
        });
      }
    }
    // --approve-plan: a human builds, edits or sends back the plan (any number of times) before anything is built.
    if (o.approvePlan && !direct && !o.dryRun) {
      let error: string | undefined;
      for (;;) {
        const d = await awaitDecision(goal, round, plan, error);
        error = undefined;
        if (d.action === "approve") {
          if (!d.plan) break;
          try {
            validate(d.plan, workers);
            plan = d.plan;
            break;
          } catch (e) {
            error = `the edited plan was not used: ${msg(e)}`;
            continue;
          }
        }
        const why = `The person reviewing your plan rejected it:\n${d.note || "(no reason given)"}\nRevise the plan accordingly.`;
        const again = await makePlan(
          architect,
          workers,
          skills,
          goal,
          failures,
          [note, why].filter(Boolean).join("\n\n"),
          modelFor(power, models, "architect", "architect"),
          ctx,
          previous,
          brief,
          notes,
        );
        plan = again.plan;
        planCost += again.cost;
      }
    }
    // After planning, so a brief the architect just wrote reaches this round's agents. The fast path's task has them already.
    refreshChecks();
    ctx.repoContext =
      (direct ? "" : repoContext(o.brief ? readBrief() : "", notes)) +
      (cfg.setup
        ? `## Dependencies\nNever install packages yourself. To add one, add it to the manifest (package.json, requirements.txt, ` +
          `pyproject.toml, go.mod, ...); the orchestrator runs \`${cfg.setup}\` before the checks.\n\n`
        : "");
    console.log(`plan: ${plan.summary}\n` + plan.tasks.map((t) => `  [${t.phase}] ${t.agent}: ${t.task.slice(0, 70)}`).join("\n"));
    const planTokens = tokenUsageDelta(ctx.budget.tokens, planTokensBefore);
    emit("plan", {
      round,
      summary: plan.summary,
      cost: round4(planCost),
      ...(planTokens ? { tokens: planTokens } : {}),
      tasks: plan.tasks.map((t, id) => ({ id, ...t })),
    });
    if (o.dryRun) return true;

    const idOf = new Map(plan.tasks.map((t, id) => [t, id]));
    const statuses = new Map<Task, string>();
    const roundSessions: Session[] = [];
    const skip = (t: Task) => (
      statuses.set(t, "SKIPPED"),
      emit("task_end", { round, id: idOf.get(t)!, agent: t.agent, phase: t.phase, status: "SKIPPED", touched: [] })
    );
    /** Never throws: a failed task becomes a failure for the next round, and its siblings run to the end. */
    const exec = async (t: Task): Promise<Result> => {
      const id = idOf.get(t)!;
      const tasksOfAgent = plan.tasks.filter((x) => x.agent === t.agent && x.phase !== "verify").length;
      const prev = o.resume ? pickSession(t, sessions, tasksOfAgent) : undefined;
      emit("task_start", { round, id, agent: t.agent, phase: t.phase, ...(prev ? { resumed: prev.round } : {}) });
      try {
        const role: Role = t.agent === "dev" ? "dev" : t.heavy ? "heavy" : "impl";
        const model = modelFor(agentPower.get(t.agent) ?? power, agentModels.get(t.agent) ?? models, role, t.agent);
        const r = await execute(t, byName.get(t.agent)!, model, ctx, prev && { id: prev.id, round: prev.round });
        const status = /Status:\s*(COMPLETE|PARTIAL|FAILED)/i.exec(r.out)?.[1]?.toUpperCase() ?? (r.out.startsWith("PHANTOM") ? "PHANTOM" : "UNKNOWN");
        statuses.set(t, status);
        if (r.session) roundSessions.push({ agent: t.agent, id: r.session, files: t.files ?? [], round });
        emit("task_end", {
          round,
          id,
          agent: t.agent,
          phase: t.phase,
          status,
          touched: r.touched,
          cost: round4(r.cost),
          ...taskReport(r.out),
          ...(r.tokens ? { tokens: r.tokens } : {}),
        });
        return { ...r, status };
      } catch (e) {
        statuses.set(t, "ERROR");
        emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: "ERROR", error: msg(e), touched: [] });
        return { agent: t.agent, out: `ERROR: ${msg(e)}`, touched: [], cost: 0, error: msg(e), fatal: isFatal(e) ? e : undefined, status: "ERROR" };
      }
    };

    const foundation = plan.tasks.filter((t) => t.phase === "foundation");
    const build = plan.tasks.filter((t) => t.phase === "build");
    const verify = plan.tasks.filter((t) => t.phase === "verify");

    const results: Result[] = [];
    // Files already changed before this round's agents ran (a commit that failed earlier) are not theirs.
    const changedBefore = cp ? new Set(changedFiles().map(normPath)) : new Set<string>();
    for (const t of foundation) {
      if (results.some((r) => r.error)) skip(t);
      else results.push(await exec(t));
    }
    const foundationFailed = results.some((r) => r.error);
    if (foundationFailed) build.forEach(skip);
    else {
      // The batch shares the unreserved budget equally (see reserve()).
      ctx.budget.launching = build.length;
      try {
        results.push(...(await Promise.all(build.map(exec))));
      } finally {
        ctx.budget.launching = 0;
      }
    }
    for (const r of results) console.log(`[${r.agent}] touched ${r.touched.length} file(s)`);
    const errors = results.filter((r) => r.error).map((r) => `${r.agent} task failed: ${r.error}`);

    // Ownership: files changed outside every task's list. Plans without file lists (fast path) are exempt.
    const owned = new Set(plan.tasks.flatMap((t) => t.files ?? []).map(normPath));
    const unowned = cp && owned.size && !foundationFailed ? changedFiles().filter((f) => !owned.has(normPath(f)) && !changedBefore.has(normPath(f))) : [];
    if (unowned.length) {
      console.warn(`files changed outside every task's list: ${unowned.join(", ")}`);
      emit("unowned", { round, files: unowned, strict: o.strictFiles });
    }
    // Protected paths: whatever an agent changed there anyway is put back before the commit, and fails the round.
    const touchedProtected = cp && !foundationFailed ? changedFiles().filter((f) => protectedBy(f) && !changedBefore.has(normPath(f))) : [];
    if (touchedProtected.length) {
      revertPaths(touchedProtected);
      console.warn(`changed protected paths, reverted: ${touchedProtected.join(", ")}`);
      emit("protected", { round, files: touchedProtected });
    }
    // Secrets: never commit them (so never push them); the round fails until they are gone.
    const secrets = cp ? scanSecrets() : [];
    if (secrets.length) {
      console.warn(`secrets in the changes, not committed: ${secrets.map((x) => `${x.what} in ${x.file}`).join(", ")}`);
      emit("secrets", { round, found: secrets });
    }
    const committed = cp && !secrets.length ? tryCommit(`orch: ${title ?? short(goal)} (round ${round})`) : null;
    const diffForRound = roundDiff(roundBase, dirtyAtStart, secrets.length > 0);
    emit("round_diff", { round, diff: diffForRound });
    const progressed = cp ? !!committed || !!dirtyFiles() : results.some((r) => r.touched.length > 0);
    // Budget or usage limit: siblings have finished and the work is committed; end the goal.
    const fatal = results.find((r) => r.fatal)?.fatal;
    if (fatal) {
      verify.forEach(skip);
      throw fatal;
    }

    const verdicts: Verdict[] = [];
    let checkResults: Check[] = [];
    let visual: VisualResult | null = null;
    /** Which of the round's browser-checked pages belong to each verify task. */
    const pagesOf = new Map<Task, number[]>();
    for (const t of verify) {
      const first = [...pagesOf.values()].reduce((n, ps) => n + ps.length, 0);
      pagesOf.set(
        t,
        (t.visual ?? []).map((_, j) => first + j),
      );
    }
    let reviewsP: Promise<(Review & { agent: string; cost: number })[]> = Promise.resolve([]);
    if (foundationFailed)
      verify.forEach(skip); // building on a broken foundation is pointless to verify
    else {
      const setup = runSetup(cfg, !!cp);
      refreshChecks();
      checkResults = setup && !setup.ok ? [setup] : [...(setup ? [setup] : []), ...runChecks(checks)];
      emit("checks", { round, results: checkResults.map(({ name, command, ok, code, ms }) => ({ name, command, ok, code, ms })) });
      // Diff reviews run next to QA, but only on a round the checks and tasks have not already failed.
      const clean = !errors.length && checkResults.every((c) => c.ok);
      reviewsP = clean
        ? Promise.all(
            diffReviewers.map(async ({ agent, lens }) => {
              const rv = await reviewDiff(agent, lens, goal, cp, modelFor(power, models, "qa", agent.name), ctx);
              emit("review", {
                round,
                agent: agent.name,
                lens,
                approved: rv.approved,
                issues: rv.issues,
                cost: round4(rv.cost),
                ...(rv.tokens ? { tokens: rv.tokens } : {}),
              });
              return { agent: agent.name, ...rv };
            }),
          )
        : Promise.resolve([]);
      // Browser check: the pages the verify tasks name, in a real browser, before QA (which gets the screenshots).
      const pages = verify.flatMap((t) => t.visual ?? []);
      if (browserCheck && DEV_SERVER && clean && pages.length) {
        const down = setup ? await DEV_SERVER.restart() : await DEV_SERVER.ensure();
        const rel = `${VISUAL_DIR}/round-${round}`;
        visual = down
          ? { url: browserCheck.serve.url, shots: [], problems: [down], observations: [], ms: 0 }
          : await captureVisual({ exe: browserCheck.exe, profile: profileDir(), base: browserCheck.serve.url, targets: pages, outDir: rel, relDir: rel });
        console.log(
          `browser check: ${visual.shots.length} screenshot(s), ${visual.problems.length} problem(s), ${visual.observations.length} observation(s)` +
            (visual.problems.length ? `\n- ${visual.problems.join("\n- ")}` : ""),
        );
        emit("visual", { round, ...visual });
      }
      const report = results.map((r) => `[${r.agent}] ${r.out}`).join("\n");
      const diff =
        (cp ? `\n\nChanges since the checkpoint:\n${diffSummary(cp)}` : "") +
        (unowned.length ? `\n\nFiles changed outside every task's file list (check that each was needed and is correct):\n- ${unowned.join("\n- ")}` : "") +
        checkReport(checkResults);
      for (const t of verify) {
        const id = idOf.get(t)!;
        emit("task_start", { round, id, agent: t.agent, phase: t.phase });
        let reportText: string | undefined;
        try {
          const r = await run(
            byName.get(t.agent)!,
            modelFor(power, models, "qa", t.agent),
            `${ctx.repoContext ?? ""}Goal: ${goal}\n${t.task}\n\nImplementer reports:\n${report}${diff}${visual ? visualReport(visual, pagesOf.get(t) ?? []) : ""}${VERDICT_FORMAT}`,
            ctx,
            true,
          );
          reportText = r.text;
          const v = asVerdict(extractJson<Verdict>(r.text));
          if (v.notes) goalNotes.push(...v.notes);
          statuses.set(t, v.passed ? "PASS" : "FAIL");
          emit("task_end", {
            round,
            id,
            agent: t.agent,
            phase: t.phase,
            status: v.passed ? "PASS" : "FAIL",
            failures: v.failures,
            touched: [],
            cost: round4(r.cost),
            ...taskReport(r.text),
            ...(r.tokens ? { tokens: r.tokens } : {}),
          });
          verdicts.push(v);
        } catch (e) {
          emit("task_end", {
            round,
            id,
            agent: t.agent,
            phase: t.phase,
            status: "ERROR",
            error: redactOutput(msg(e)),
            touched: [],
            ...(reportText === undefined ? {} : taskReport(reportText)),
          });
          if (isFatal(e)) throw e;
          verdicts.push({ passed: false, failures: [`${t.agent} could not verify: ${redactOutput(msg(e))}`] });
        }
      }
    }

    const reviews = await reviewsP;
    const reviewFailures = reviews.filter((r) => !r.approved).flatMap((r) => r.issues.map((i) => `${r.agent} (review): ${i}`));
    const visualFailures = visual?.problems.map((p) => `browser check: ${p}`) ?? [];
    // Exit codes beat opinions: a failed check fails the round whatever QA says.
    const checkFailures = checkResults.filter((c) => !c.ok).map((c) => `check "${c.name}" failed (\`${c.command}\`, exit ${c.code}):\n${c.output.slice(-800)}`);
    // A plan without verify tasks (fast path with checks) is judged by the checks alone; at least one must have run.
    const verifiedBy = verify.length ? verdicts.length > 0 && verdicts.every((v) => v.passed) : checkResults.length > 0;
    const passed =
      !errors.length &&
      !checkFailures.length &&
      !visualFailures.length &&
      verifiedBy &&
      !reviewFailures.length &&
      !(o.strictFiles && unowned.length) &&
      !touchedProtected.length &&
      !secrets.length;
    const prevKey = failureKey(failures);
    const ownershipFailures =
      o.strictFiles && unowned.length
        ? [`files changed outside every task's file list: ${unowned.join(", ")}. Give them to a task in the plan, or have their changes reverted.`]
        : [];
    const safetyFailures = [
      ...(touchedProtected.length
        ? [`changed protected paths (they were reverted): ${touchedProtected.join(", ")}. They must not be changed; reach the goal without them.`]
        : []),
      ...secrets.map(
        (x) =>
          `${x.what} in ${x.file}: secrets must never be committed. Remove it and read it from the environment or a config file that is not committed instead.`,
      ),
    ];
    failures = [
      ...errors,
      ...checkFailures,
      ...visualFailures,
      ...ownershipFailures,
      ...safetyFailures,
      ...verdicts.flatMap((v) => v.failures),
      ...reviewFailures,
    ];
    const roundCost = round4(ctx.budget.spent - spentBefore);
    const roundTokens = tokenUsageDelta(ctx.budget.tokens, tokensBefore);
    const checkSummary = checkResults.map(({ name, ok, code }) => ({ name, ok, code }));
    lr.state.push({
      round,
      power,
      plan: plan.summary,
      touched: results.flatMap((r) => r.touched),
      checks: checkSummary,
      passed,
      failures,
      cost: roundCost,
      diff: diffForRound,
      ...(roundTokens ? { tokens: roundTokens } : {}),
    });
    lr.cost = round4(ctx.budget.spent);
    lr.tokens = ctx.budget.tokens;
    writeLastRun(lr);

    emit("round_end", { round, passed, failures, cost: roundCost, diff: diffForRound, ...(roundTokens ? { tokens: roundTokens } : {}) });
    if (passed) return (console.log("\nQA passed."), true);
    console.log(`QA failed (${failures.length}):\n- ${failures.join("\n- ")}`);
    previous = direct ? "" : previousRound(round, plan, statuses, cp);

    // Stuck detection: no file changed, or exactly the same failures as the round before.
    const repeated = round > 1 && failureKey(failures) === prevKey;
    if (!progressed || repeated) {
      stuck++;
      const why = !progressed ? "the round changed no files" : "the round ended with the same failures as the one before";
      if (stuck >= 2) {
        emit("stuck", { round, action: "stop", reason: why });
        console.error(`\nStopped: no progress in ${stuck} rounds in a row (${why}).`);
        return false;
      }
      // Per-task escalation: when some implementer tasks failed outright, move only their agents up a tier;
      // when every task claims success (the plan or the verification is the problem), move the whole round up.
      const failedAgents = [...new Set(results.filter((r) => r.status && !["COMPLETE", "SKIPPED"].includes(r.status)).map((r) => r.agent))];
      const someWorked = results.some((r) => r.status === "COMPLETE");
      const raisable = failedAgents.filter((a) => TIERS.indexOf(agentPower.get(a) ?? power) < TIERS.length - 1);
      if (failedAgents.length && someWorked && raisable.length) {
        for (const a of raisable) {
          agentPower.set(a, TIERS[TIERS.indexOf(agentPower.get(a) ?? power) + 1]);
          agentModels.set(a, bumpAliases(agentModels.get(a) ?? models));
        }
        const moved = raisable.map((a) => `${a} -> ${agentPower.get(a)}`).join(", ");
        emit("stuck", { round, action: "escalate", reason: why, power, agents: Object.fromEntries(raisable.map((a) => [a, agentPower.get(a)])) });
        console.warn(`no progress (${why}); moving up only the failing tasks' agents: ${moved}`);
      } else {
        const next = TIERS[TIERS.indexOf(power) + 1];
        emit("stuck", { round, action: next ? "escalate" : "retry", reason: why, power: next ?? power });
        console.warn(`no progress (${why}); ${next ? `moving up to power ${next}` : "already at max power, retrying"}`);
        if (next) {
          power = next;
          models = bumpAliases(models);
        }
      }
      note = `Note: ${why}. Do not repeat the previous plan; find the real cause and take a different approach.`;
      // A fresh look: the next round's agents start cold instead of continuing the approach that got stuck.
      sessions = [];
    } else {
      stuck = 0;
      note = "";
      sessions = roundSessions;
    }
  }
  console.error(`\nStopped: max rounds (${o.maxRounds}) reached without QA passing.`);
  return false;
}

// ---------- queue + loop ----------
/** The queue, checked: a damaged file stops orch with a clear message instead of being overwritten. */
function readQueue(): Item[] {
  if (!existsSync(QUEUE)) return [];
  let q: unknown;
  try {
    q = JSON.parse(readFileSync(QUEUE, "utf8"));
  } catch (e) {
    throw new Error(`${QUEUE} is not valid JSON (${msg(e)}). Nothing was changed; fix or move the file.`, { cause: e });
  }
  if (!Array.isArray(q) || !q.every((i) => i && typeof i.id === "number" && typeof i.goal === "string" && typeof i.status === "string"))
    throw new Error(`${QUEUE} is not a list of {id, goal, status} goals. Nothing was changed; fix or move the file.`);
  return q as Item[];
}
/** The loop exits before its next goal when this file exists (it is removed when acted on). */
function stopRequested(): boolean {
  if (!existsSync(STOP_FILE)) return false;
  try {
    unlinkSync(STOP_FILE);
  } catch {
    /* removed meanwhile */
  }
  return true;
}

/** One minute past the reset (the CLI rounds the time); 30 min if the reply had no time. ORCH_LIMIT_WAIT_MS overrides it for tests. */
function waitUntil(resetAt?: number) {
  const override = Number(process.env.ORCH_LIMIT_WAIT_MS);
  return override > 0 ? Date.now() + override : (resetAt ?? Date.now() + 29 * 60_000) + 60_000;
}

/** `orch run` with --on-limit wait: sleep until the reset, then the caller retries the goal. */
async function waitForReset(e: UsageLimit) {
  const until = waitUntil(e.resetAt);
  console.log(`usage limit reached; waiting until ${new Date(until).toLocaleString()} and then retrying the goal (Ctrl+C to stop).`);
  emit("waiting", { reason: "usage_limit", until });
  while (Date.now() < until) await sleep(Math.min(5000, until - Date.now()));
}

// ---------- priority and issue comments ----------
const DEFAULT_PRIORITY = 3;

/** A priority from label names: "p1".."p9" (also "orch:p2", "priority:p1"), or "priority: high|medium|low" / "urgent". */
function priorityOf(labels: string[]): number | undefined {
  for (const l of labels.map((x) => x.trim().toLowerCase())) {
    const n = /^(?:orch[:/ -]?|priority[:/ -]?)?p([1-9])$/.exec(l)?.[1];
    if (n) return Number(n);
    const word = /^(?:priority[:/ -]?\s*)?(urgent|critical|high|medium|normal|low)$/.exec(l)?.[1];
    if (word) return { urgent: 1, critical: 1, high: 2, medium: 3, normal: 3, low: 5 }[word];
  }
  return undefined;
}

let ISSUE_COMMENTS = true;

/** A comment on the GitHub issue a goal came from. Never throws: a failed comment is only reported. */
function commentIssue(issue: number | undefined, body: string) {
  if (!issue || !ISSUE_COMMENTS) return;
  try {
    const gh = resolveCommand(process.env.GH_BIN ?? "gh");
    if (gh.missing) throw new Error("gh not found");
    const r = spawnSync(gh.file, [...gh.pre, "issue", "comment", String(issue), "--body-file", "-"], {
      input: `${body}\n\n<sub>YAAIORCH</sub>\n`,
      encoding: "utf8",
      shell: gh.shell,
      windowsHide: true,
      timeout: 60_000,
    });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || String(r.error ?? "")).trim().slice(0, 200));
  } catch (e) {
    console.warn(`could not comment on issue #${issue} (${msg(e)})`);
  }
}

// ---------- orch intake: goals from GitHub issues with a label, or from a backlog file ----------
type IntakeSource = { kind: "github"; label: string } | { kind: "backlog"; file: string };

/** "github:LABEL,backlog:FILE" (or a list of them) into sources; a bad one is an error. */
function parseIntake(v: unknown): IntakeSource[] {
  const parts = (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]).flatMap((x) => String(x).split(","));
  return parts
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x): IntakeSource => {
      const m = /^(github|backlog):(.+)$/.exec(x);
      if (!m) throw new Error(`--intake: "${x}" is not github:LABEL or backlog:FILE`);
      if (m[1] === "github") {
        if (!/^[\w .:/-]{1,50}$/.test(m[2])) throw new Error(`--intake: "${m[2]}" is not a label name`);
        return { kind: "github", label: m[2] };
      }
      return { kind: "backlog", file: m[2] };
    });
}

/** Open issues with the label, oldest first (gh, in this repo). */
function githubIssues(label: string): { number: number; title: string; body: string; priority?: number }[] {
  const gh = resolveCommand(process.env.GH_BIN ?? "gh");
  if (gh.missing) throw new Error("gh (GitHub CLI) was not found; install it and run gh auth login to read issues");
  const r = spawnSync(gh.file, [...gh.pre, "issue", "list", "--label", label, "--state", "open", "--limit", "100", "--json", "number,title,body,labels"], {
    encoding: "utf8",
    shell: gh.shell,
    windowsHide: true,
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`gh issue list failed: ${(r.stderr || r.stdout || String(r.error ?? "")).trim().slice(0, 300)}`);
  const list = JSON.parse(r.stdout || "[]") as { number?: unknown; title?: unknown; body?: unknown; labels?: unknown }[];
  return list
    .filter((i) => Number.isInteger(i.number) && typeof i.title === "string")
    .map((i) => ({
      number: i.number as number,
      title: (i.title as string).trim(),
      body: typeof i.body === "string" ? i.body.trim() : "",
      priority: priorityOf(Array.isArray(i.labels) ? i.labels.map((l) => String((l as { name?: unknown })?.name ?? l)) : []),
    }))
    .sort((a, b) => a.number - b.number);
}

/** Unchecked "- [ ] ..." items of a markdown file, with their indented lines; the key is a hash of the text. */
function backlogItems(file: string): { key: string; text: string; priority?: number }[] {
  if (!existsSync(file)) throw new Error(`backlog file ${file} not found`);
  const out: { key: string; text: string; priority?: number }[] = [];
  let cur: string[] | null = null;
  const flush = () => {
    if (cur?.length) {
      const text = cur.join("\n").trim();
      const pr = /^\((p[1-9])\)\s*/i.exec(text);
      out.push({
        key: createHash("sha256").update(text).digest("hex").slice(0, 16),
        text: pr ? text.slice(pr[0].length) : text,
        ...(pr ? { priority: Number(pr[1].slice(1)) } : {}),
      });
    }
    cur = null;
  };
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^[-*]\s+\[ \]\s+(.*)$/.exec(line);
    if (m) {
      flush();
      cur = [m[1]];
    } else if (cur && /^\s+\S/.test(line) && !/^\s*[-*]\s+\[[ xX]\]/.test(line)) cur.push(line.trim());
    else flush();
  }
  flush();
  return out;
}

/** Queue what the sources have that the queue has not seen (any status), oldest first. Returns the new ids. */
function intake(sources: IntakeSource[]): number[] {
  const added: number[] = [];
  for (const src of sources) {
    const found =
      src.kind === "github"
        ? githubIssues(src.label).map((i) => ({
            goal: `${i.title}${i.body ? `\n\n${i.body.slice(0, 4000)}` : ""}`,
            issue: i.number,
            backlog: undefined,
            priority: i.priority,
          }))
        : backlogItems(src.file).map((b) => ({ goal: b.text.slice(0, 4000), issue: undefined, backlog: b.key, priority: b.priority }));
    const ids = updateQueue((q) => {
      const made: number[] = [];
      for (const f of found) {
        if (q.some((i) => (f.issue && i.issue === f.issue) || (f.backlog && i.backlog === f.backlog))) continue;
        const id = Math.max(0, ...q.map((i) => i.id)) + 1;
        q.push({
          id,
          goal: f.goal,
          status: "pending",
          ...(f.issue ? { issue: f.issue } : {}),
          ...(f.backlog ? { backlog: f.backlog } : {}),
          ...(f.priority ? { priority: f.priority } : {}),
        });
        made.push(id);
      }
      return made;
    });
    const where = src.kind === "github" ? `GitHub issues labelled "${src.label}"` : src.file;
    console.log(ids.length ? `queued ${ids.length} goal(s) from ${where}: ${ids.map((n) => `#${n}`).join(", ")}` : `nothing new in ${where}`);
    if (ids.length) emit("intake", { source: src.kind === "github" ? `github:${src.label}` : `backlog:${src.file}`, ids });
    added.push(...ids);
  }
  return added;
}

/** Comment on the GitHub issue a queue goal came from, if it came from one. */
const commitIssueNote = (item: Item, body: string) => commentIssue(item.issue, body);

/** The first pending goal whose goals-it-needs are all done (a goal never waits on a later one). */
function nextRunnable(q: Item[]): Item | undefined {
  const status = new Map(q.map((i) => [i.id, i.status]));
  const runnable = q.filter((i) => i.status === "pending" && (i.after ?? []).every((d) => status.get(d) === "done" || !status.has(d)));
  // The most urgent first (p1 before p3), then in queue order; dependencies already decided what may run.
  return runnable.reduce<Item | undefined>(
    (best, i) => (!best || (i.priority ?? DEFAULT_PRIORITY) < (best.priority ?? DEFAULT_PRIORITY) ? i : best),
    undefined,
  );
}

/** Mark pending goals that need a failed or blocked one as blocked (repeatedly, down the chain). Returns them. */
function blockDependents(q: Item[]): Item[] {
  const out: Item[] = [];
  for (let changed = true; changed;) {
    changed = false;
    const byId = new Map(q.map((i) => [i.id, i]));
    for (const i of q) {
      if (i.status !== "pending") continue;
      const bad = (i.after ?? []).map((d) => byId.get(d)).find((d) => d && (d.status === "failed" || d.status === "blocked"));
      if (!bad) continue;
      i.status = "blocked";
      i.note = `needs #${bad.id}, which ${bad.status === "failed" ? "failed" : "is blocked"}; run "orch retry ${bad.id}" once it is fixed`;
      out.push(i);
      changed = true;
    }
  }
  return out;
}

/** `orch retry ID`: a failed or blocked goal, and the goals it blocked, back to pending (a fresh retry budget). */
function retryGoal(id: number) {
  const back = updateQueue((q) => {
    const it = q.find((i) => i.id === id);
    if (!it) throw new Error(`no goal #${id} in the queue`);
    if (it.status !== "failed" && it.status !== "blocked") throw new Error(`goal #${id} is ${it.status}; only a failed or blocked goal can be retried`);
    const reset: Item[] = [it];
    // The goals blocked behind it, down the chain.
    for (let changed = true; changed;) {
      changed = false;
      for (const i of q)
        if (i.status === "blocked" && !reset.includes(i) && (i.after ?? []).some((d) => reset.some((r) => r.id === d))) {
          reset.push(i);
          changed = true;
        }
    }
    for (const i of reset) {
      i.status = "pending";
      delete i.note;
      delete i.attempts;
    }
    return reset.map((i) => i.id);
  });
  console.log(`back in the queue: ${back.map((n) => `#${n}`).join(", ")}`);
}

async function loop(o: Opts, pollSec: number, untilEmpty: boolean) {
  ISSUE_COMMENTS = o.issueComments;
  if (o.dryRun) throw new Error("--dry-run cannot be used with loop: the goal would stay pending and be planned again forever");
  // The run lock guarantees one orchestrator per repo, so anything still "running" was interrupted (crash or Stop).
  const stale = updateQueue((q) => {
    const s = q.filter((i) => i.status === "running");
    s.forEach((i) => (i.status = "pending"));
    return s;
  });
  if (stale.length) console.log(`reset interrupted goal(s) to pending: ${stale.map((i) => `#${i.id}`).join(", ")}`);
  if (existsSync(STOP_FILE)) unlinkSync(STOP_FILE); // a request left over from an earlier loop
  const stopNow = () => {
    if (!stopRequested()) return false;
    console.log("stop requested: not starting another goal");
    emit("loop_stop", { reason: "requested" });
    return true;
  };

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.log("\nstopping after current goal...");
  });
  /** --max-cost-total: what the goals of this loop run have spent so far. */
  let spentTotal = 0;
  while (!stop) {
    if (stopNow()) break;
    if (o.maxCostTotal !== undefined && o.maxCostTotal - spentTotal < 0.01) {
      console.log(`loop budget of ${usd(o.maxCostTotal)} used up (${usd(spentTotal)} spent): not starting another goal`);
      emit("loop_stop", { reason: "budget", spent: round4(spentTotal) });
      break;
    }
    const { item, blocked } = updateQueue((q) => {
      const newlyBlocked = blockDependents(q);
      const next = nextRunnable(q);
      if (next) {
        next.status = "running";
        delete next.note;
      }
      return { item: next && { ...next }, blocked: newlyBlocked };
    });
    for (const b of blocked) {
      console.warn(`goal #${b.id} is blocked: ${b.note}`);
      emit("blocked", { id: b.id, goal: b.goal, note: b.note });
      // "#N" would link to issue N on GitHub: say "queue goal N".
      commitIssueNote(b, `Waiting: this ${(b.note ?? "").replace(/#(\d+)/g, "queue goal $1")}.`);
    }
    if (!item) {
      if (o.intake.length) {
        try {
          if (intake(o.intake).length) continue;
        } catch (e) {
          console.warn(`intake failed (${msg(e)}); trying again later`);
        }
      }
      if (o.coverage) {
        const c = await coverageCheck(o);
        spentTotal += c.cost;
        if (c.queued) continue;
      }
      if (untilEmpty) break;
      await sleep(pollSec * 1000);
      continue;
    }
    console.log(`\n##### goal #${item.id}: ${item.goal}`);
    emit("queue_item", { id: item.id, goal: item.goal });
    if (!item.attempts && !item.resumeFrom) commitIssueNote(item, `Working on this now (queue goal ${item.id}, power ${item.power ?? o.power}).`);
    /** "budget": the loop's budget (not the goal's own --max-cost) ran out during the goal; it is not the goal's fault. */
    let outcome: "done" | "failed" | "limit" | "budget" = "failed";
    let resetAt: number | undefined;
    let noRetry = false;
    const started = Date.now();
    // With a loop budget, a goal may spend at most what is left of it (and its own --max-cost, if lower).
    const left = o.maxCostTotal === undefined ? undefined : o.maxCostTotal - spentTotal;
    const loopCapped = left !== undefined && left < (o.maxCost ?? Infinity);
    try {
      const goalOpts = {
        ...o,
        ...(left === undefined ? {} : { maxCost: Math.min(o.maxCost ?? Infinity, left) }),
        // A retried goal runs a tier higher (see below).
        ...(item.power ? { power: item.power, models: bumpAliases(o.models) } : {}),
      };
      lastGoalCost = 0;
      try {
        outcome = (await runGoal(item.goal, goalOpts, item.id, item.brief, item.resumeFrom, item.issue)) ? "done" : "failed";
      } finally {
        spentTotal += lastGoalCost;
      }
    } catch (e) {
      if (e instanceof UsageLimit) {
        outcome = "limit";
        resetAt = e.resetAt;
      } else if (e instanceof BudgetExceeded && loopCapped) {
        outcome = "budget";
        console.log(`the queue's budget ran out during goal #${item.id}; it stays pending`);
      } else {
        if (e instanceof BudgetExceeded) noRetry = true; // more power would only spend more of a budget already gone
        console.error(process.env.ORCH_DEBUG ? e : `Error: ${msg(e)}`);
      }
    }
    const until = outcome === "limit" ? waitUntil(resetAt) : 0;
    updateQueue((q) => {
      // Edited under the queue lock: goals added meanwhile stay.
      const cur = q.find((i) => i.id === item.id);
      if (!cur) return;
      // A usage limit or the queue's budget is not the goal's fault: put it back (after the reset, or a bigger budget).
      cur.status = outcome === "limit" || outcome === "budget" ? "pending" : outcome;
      if (outcome === "budget") cur.note = "the queue's budget ran out during this goal; raise it and process the queue again";
      cur.cost = round4((cur.cost ?? 0) + lastGoalCost);
      // Where an interrupted attempt left its work; any other outcome used it up (or its branch is gone).
      if (outcome === "limit" && lastParked) cur.resumeFrom = lastParked;
      else delete cur.resumeFrom;
      cur.seconds = (cur.seconds ?? 0) + Math.round((Date.now() - started) / 1000);
      // A failed goal gets another try, a tier higher, before the goals that build on it are blocked.
      const tier = TIERS.indexOf(cur.power ?? o.power);
      if (outcome === "failed" && !noRetry && (cur.attempts ?? 0) < o.retries) {
        cur.attempts = (cur.attempts ?? 0) + 1;
        cur.power = TIERS[Math.min(tier + 1, TIERS.length - 1)];
        cur.status = "pending";
        cur.note = `failed; retry ${cur.attempts} of ${o.retries} at power ${cur.power}`;
        console.log(`goal #${cur.id} failed; trying it again at power ${cur.power} (retry ${cur.attempts} of ${o.retries})`);
        emit("retry", { id: cur.id, attempt: cur.attempts, power: cur.power });
      }
      if (outcome === "limit")
        cur.note =
          o.onLimit === "stop"
            ? `usage limit: stopped; resets ${resetAt ? new Date(resetAt).toLocaleString() : "later"}`
            : `usage limit: retrying after ${new Date(until).toLocaleString()}`;
    });
    // For UIs: the queue on disk changed (status, cost, time), read it again.
    emit("queue_changed", { id: item.id });
    // The issue it came from hears how it ended (not about a retry or a pause: those come back).
    const final = readQueue().find((i) => i.id === item.id);
    if (final?.issue && (final.status === "done" || final.status === "failed")) {
      const last = readJsonFile<LastRun | null>(LAST_RUN, null);
      const fails = ((last?.state.at(-1) as { failures?: string[] } | undefined)?.failures ?? []).slice(0, 3);
      commitIssueNote(
        final,
        final.status === "done"
          ? `Done${last?.pr ? `: pull request ${last.pr}` : last?.branch ? ` on branch \`${last.branch}\`` : ""}.` +
              (last?.ci === "fail" ? " Its CI checks still fail, though; it needs a look." : last?.ci === "pass" ? " Its CI checks pass." : "")
          : `Could not finish this${final.attempts ? ` after ${final.attempts + 1} attempts` : ""}.` +
              (fails.length ? `\n\nWhat was still wrong:\n${fails.map((f) => `- ${f.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}` : "") +
              `\n\nAfter a fix, put it back in the queue with \`orch retry ${final.id}\` (or Retry in the UI).`,
      );
    }
    // Never pick the same goal again with the few cents left: stop here.
    if (outcome === "budget") {
      console.log(`loop budget of ${usd(o.maxCostTotal!)} used up (${usd(spentTotal)} spent): goal #${item.id} is pending again`);
      emit("loop_stop", { reason: "budget", spent: round4(spentTotal) });
      break;
    }
    if (outcome === "limit" && o.onLimit === "stop") {
      console.log(`usage limit reached; goal #${item.id} is pending again. Stopping (--on-limit stop).`);
      process.exit(3);
    }
    if (outcome === "limit") {
      console.log(`usage limit reached; goal #${item.id} is pending again. Waiting until ${new Date(until).toLocaleString()} (Ctrl+C to stop).`);
      emit("waiting", { reason: "usage_limit", until });
      while (!stop && !existsSync(STOP_FILE) && Date.now() < until) await sleep(Math.min(5000, until - Date.now()));
      updateQueue((q) => {
        const again = q.find((i) => i.id === item.id);
        if (again) delete again.note;
      });
    }
  }
}

function parseOpts(values: Record<string, string | boolean | undefined>): Opts {
  const maxRounds = Number(values["max-rounds"]);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error(`--max-rounds must be a whole number of at least 1, got "${values["max-rounds"]}"`);
  const power = String(values.power);
  if (!Object.hasOwn(POWER, power)) throw new Error(`--power must be one of ${Object.keys(POWER).join(", ")}, got "${power}"`);
  const timeout = Number(values["agent-timeout"]);
  if (!(timeout > 0)) throw new Error(`--agent-timeout must be a positive number of minutes, got "${values["agent-timeout"]}"`);
  let maxCost: number | undefined;
  if (values["max-cost"] !== undefined) {
    maxCost = Number(values["max-cost"]);
    if (!(maxCost > 0)) throw new Error(`--max-cost must be a positive amount in USD, got "${values["max-cost"]}"`);
  }
  const cfgEarly = readJsonFile<Config>(CONFIG_FILE, {});
  const totalRaw = values["max-cost-total"] ?? cfgEarly.maxCostTotal;
  let maxCostTotal: number | undefined;
  if (totalRaw !== undefined) {
    maxCostTotal = Number(totalRaw);
    if (!(maxCostTotal > 0)) throw new Error(`--max-cost-total must be a positive amount in USD, got "${totalRaw}"`);
  }
  const strictFiles = !!values["strict-files"] || cfgEarly.strictFiles === true;
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  const models = mergeModels(cfg.models, parseModelSpec(String(values.model ?? "")));
  const onLimit = String(values["on-limit"] ?? cfg.onLimit ?? "wait");
  if (onLimit !== "wait" && onLimit !== "stop") throw new Error(`--on-limit must be wait or stop, got "${onLimit}"`);
  const usageCap = parseUsageCap(String(values["usage-cap"] ?? ""), cfg.usageCap);
  const plugins = parsePlugins(values, cfg.plugins);
  const brief = !values["no-brief"] && cfg.brief !== false;
  const notes = !values["no-notes"] && cfg.notes !== false;
  const critic = !!values.critic || cfg.critic === true;
  const resume = !values["no-resume"] && cfg.resume !== false;
  const diffCritic = !!values["diff-critic"] || cfg.diffCritic === true;
  const named = String(values.reviewers ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const fromCfg = Array.isArray(cfg.review) ? cfg.review.map(String) : [];
  const review = named.length ? named : values.review || cfg.review === true ? [] : fromCfg.length ? fromCfg : null;
  for (const a of review ?? []) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(a)) throw new Error(`--reviewers: "${a}" is not an agent name`);
  const pr = !!values.pr || cfg.pr === true;
  // A pull request needs a branch of its own.
  const branch = pr || !!values.branch || cfg.branch === true;
  const approvePlan = !!values["approve-plan"] || cfg.approvePlan === true;
  const coverage = !values["no-coverage"] && cfg.coverage !== false;
  const intake = parseIntake(values.intake ?? cfg.intake);
  const protect =
    values.protect !== undefined
      ? String(values.protect)
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : Array.isArray(cfg.protect)
        ? cfg.protect.map(String)
        : [".github/workflows/"];
  const secretScan = !values["no-secret-scan"] && cfg.secretScan !== false;
  const issueComments = !values["no-issue-comments"] && cfg.issueComments !== false;
  const visual = !values["no-visual"] && cfg.visual !== false;
  const ciFixesRaw = Number(values["ci-fixes"] ?? cfg.ciFixes ?? 2);
  if (!Number.isInteger(ciFixesRaw) || ciFixesRaw < 0 || ciFixesRaw > 5)
    throw new Error(`--ci-fixes must be 0 to 5, got "${values["ci-fixes"] ?? cfg.ciFixes}"`);
  const ciFixes = values["no-ci-watch"] || cfg.ciWatch === false ? -1 : ciFixesRaw;
  const retries = Number(values.retries ?? cfg.retries ?? 1);
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new Error(`--retries must be 0 to 3, got "${values.retries ?? cfg.retries}"`);
  return {
    maxRounds,
    power: power as Power,
    dryRun: !!values["dry-run"],
    park: false,
    agentTimeoutMs: timeout * 60_000,
    maxCost,
    fast: !!values.fast,
    models,
    onLimit,
    usageCap,
    plugins,
    brief,
    notes,
    critic,
    resume,
    diffCritic,
    review,
    branch,
    pr,
    approvePlan,
    coverage,
    retries,
    intake,
    protect,
    secretScan,
    issueComments,
    ciFixes,
    visual,
    strictFiles,
    maxCostTotal,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "max-rounds": { type: "string", default: "5" },
      power: { type: "string", default: "heavy" },
      "max-cost": { type: "string" },
      "max-cost-total": { type: "string" },
      "strict-files": { type: "boolean", default: false },
      "agent-timeout": { type: "string", default: "30" },
      poll: { type: "string", default: "15" },
      "until-empty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      fast: { type: "boolean", default: false },
      model: { type: "string" },
      "on-limit": { type: "string" },
      "usage-cap": { type: "string" },
      plugins: { type: "string" },
      "disable-plugins": { type: "string" },
      "no-hooks": { type: "boolean", default: false },
      "no-brief": { type: "boolean", default: false },
      "no-notes": { type: "boolean", default: false },
      "no-resume": { type: "boolean", default: false },
      critic: { type: "boolean", default: false },
      "diff-critic": { type: "boolean", default: false },
      branch: { type: "boolean", default: false },
      "approve-plan": { type: "boolean", default: false },
      reject: { type: "string" },
      "plan-stdin": { type: "boolean", default: false },
      "spec-file": { type: "string" },
      "brief-file": { type: "string" },
      "brief-file-temp": { type: "boolean", default: false },
      propose: { type: "boolean", default: false },
      accept: { type: "boolean", default: false },
      start: { type: "boolean", default: false },
      "no-coverage": { type: "boolean", default: false },
      retries: { type: "string" },
      intake: { type: "string" },
      protect: { type: "string" },
      "no-secret-scan": { type: "boolean", default: false },
      "no-issue-comments": { type: "boolean", default: false },
      "ci-fixes": { type: "string" },
      "no-ci-watch": { type: "boolean", default: false },
      "no-visual": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "save-agent": { type: "string" },
      github: { type: "string" },
      backlog: { type: "string" },
      setup: { type: "string" },
      pr: { type: "boolean", default: false },
      review: { type: "boolean", default: false },
      reviewers: { type: "string" },
      details: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "older-than": { type: "string", default: "14" },
    },
  });
  const [cmd, ...rest] = positionals;
  const goal = rest.join(" ");

  switch (cmd) {
    case "run":
      if (!goal) throw new Error('usage: orch run "<goal>"');
      {
        const o = parseOpts(values);
        acquireRunLock("run");
        let resumeFrom: string | undefined;
        for (;;) {
          try {
            process.exit((await runGoal(goal, o, undefined, undefined, resumeFrom)) ? 0 : 1);
          } catch (e) {
            // The interrupted work was moved to orchestrator/interrupted-*; the retry carries on from it.
            if (e instanceof UsageLimit && o.onLimit === "wait") {
              resumeFrom = lastParked;
              await waitForReset(e);
            } else throw e;
          }
        }
      }
    case "add": {
      if (!goal) throw new Error('usage: orch add "<goal>"');
      const id = updateQueue((q) => {
        const next = Math.max(0, ...q.map((i) => i.id)) + 1;
        q.push({ id: next, goal, status: "pending" });
        return next;
      });
      return console.log(`queued #${id}`);
    }
    case "loop": {
      const poll = Number(values.poll);
      if (!(poll > 0)) throw new Error(`--poll must be a positive number of seconds, got "${values.poll}"`);
      const o = { ...parseOpts(values), park: true };
      acquireRunLock("loop");
      return loop(o, poll, values["until-empty"]!);
    }
    case "status":
      return console.log(
        readQueue()
          .map(
            (i) =>
              `#${i.id} [${i.status}] ${i.goal}${i.after?.length ? ` (after ${i.after.map((d) => `#${d}`).join(", ")})` : ""}${i.note ? `  -- ${i.note}` : ""}`,
          )
          .join("\n") || "queue empty",
      );
    case "agents":
      if (typeof values["save-agent"] === "string") {
        const path = saveAgent(values["save-agent"], readFileSync(0, "utf8"));
        return console.log(JSON.stringify({ ok: true, path }));
      }
      if (values.json) return console.log(JSON.stringify({ agents: discoverAgents(), skills: discoverSkills() }));
      console.log(
        "agents:\n" +
          discoverAgents()
            .map((a) => `  ${a.name}${a.source === "builtin" ? " (built-in)" : ""}: ${a.description}`)
            .join("\n"),
      );
      return console.log(
        "skills:\n" +
          discoverSkills()
            .map((s) => `  ${s.name}: ${s.description}`)
            .join("\n"),
      );
    case "learn": {
      const o = parseOpts(values);
      acquireRunLock("learn");
      return learn(o);
    }
    case "approve":
      return approve(values);
    case "intake": {
      const sources = [
        ...(values.github ? parseIntake(`github:${values.github}`) : []),
        ...(values.backlog ? parseIntake(`backlog:${values.backlog}`) : []),
        ...parseIntake(values.intake),
      ];
      if (!sources.length) throw new Error("usage: orch intake --github LABEL and/or --backlog FILE");
      intake(sources);
      return;
    }
    case "retry": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error("usage: orch retry ID");
      return retryGoal(id);
    }
    case "new": {
      const [dir, ...words] = rest;
      if (!dir) throw new Error('usage: orch new DIR "<spec>"  (or --spec-file FILE)');
      const spec = briefFrom(values, words);
      return newProject(dir, spec, parseOpts(values), values.setup ? String(values.setup) : undefined, !!values.start, Number(values.poll));
    }
    case "split":
      return split(values, rest);
    case "share": {
      const o = parseOpts(values);
      acquireRunLock("share");
      return share(o);
    }
    case "stop-after":
      mkdirSync(DIR, { recursive: true });
      writeFileSync(STOP_FILE, new Date().toISOString());
      return console.log("the running loop will stop before its next goal");
    case "plugins": {
      const list = listPlugins();
      if (values.details) await pluginTokens(list);
      if (values.json) return console.log(JSON.stringify(list));
      for (const p of list) console.log(`${p.enabled ? "on " : "off"}  ${p.id}  (${p.scope})${p.tokens !== undefined ? `  ~${p.tokens} tok/call` : ""}`);
      return;
    }
    case "doctor": {
      const findings = doctor();
      if (values.json) console.log(JSON.stringify(findings));
      else for (const x of findings) console.log(`${x.level === "ok" ? "ok  " : x.level === "warn" ? "warn" : "FAIL"}  ${x.name}: ${x.detail}`);
      return process.exit(findings.some((x) => x.level === "fail") ? 1 : 0);
    }
    case "browser": {
      const [sub, arg] = rest;
      if (sub === "install") return console.log(`installed: ${await installBrowser()}`);
      const b = findBrowser();
      if (sub === "login") {
        if (!b) throw new Error('no browser found; run "orch browser install" or set YAAIORCH_BROWSER');
        const cfg = readJsonFile<Config>(CONFIG_FILE, {});
        const url = arg ?? (cfg.serve ? parseServe(cfg.serve).url : undefined);
        if (!url) throw new Error('usage: orch browser login URL (or set "serve" in .orchestrator/config.json)');
        if (!isLocalUrl(url)) throw new Error(`orch browser login opens this machine's app (localhost) only, not ${url}`);
        console.log(`Log in to the app in the window that opened, then close the window. Profile: ${profileDir()}`);
        await browserLogin(b.path, profileDir(), url);
        return console.log("done: the browser checks in this repo use this login");
      }
      if (sub && sub !== "status") throw new Error("usage: orch browser [status | login [URL] | install]");
      console.log(b ? `browser: ${b.path} (${b.via})` : 'browser: none found; run "orch browser install" or set YAAIORCH_BROWSER');
      return console.log(`profile for this repo: ${profileDir()}`);
    }
    case "rollback":
      acquireRunLock("rollback");
      return rollback(rest[0]);
    case "prune": {
      const days = Number(values["older-than"]);
      if (!(days >= 0)) throw new Error(`--older-than must be a number of days, got "${values["older-than"]}"`);
      return prune(days);
    }
    default:
      console.log(USAGE);
  }
}

// Unit tests import this file for its helpers (see test/unit.test.mjs) and set ORCH_NO_MAIN.
export {
  priorityOf,
  protectRe,
  protectedBy,
  SECRETS,
  ENV_FILE,
  validate,
  extractJson,
  parseReset,
  failureKey,
  badPath,
  normPath,
  asVerdict,
  asReview,
  TRANSIENT_RE,
  saveAgent,
};

if (!process.env.ORCH_NO_MAIN)
  main().catch((e) => {
    // Stack traces only on request: most errors here are expected ("dirty tree", "nothing to roll back").
    if (e instanceof UsageLimit) {
      // Exit 3 lets callers (the eval runner, scripts) tell "wait and retry" apart from a real failure.
      console.error(`Stopped: ${e.message}${e.resetAt ? `\nresets at ${when(e.resetAt)}` : ""}`);
      process.exit(3);
    }
    if (e instanceof BudgetExceeded) console.error(`Stopped: ${e.message}`);
    else console.error(process.env.ORCH_DEBUG ? e : `Error: ${msg(e)}`);
    process.exit(1);
  });
