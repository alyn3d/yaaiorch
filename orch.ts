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
  openSync,
  closeSync,
  statSync,
  utimesSync,
  realpathSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, basename, dirname, resolve, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { BUILTIN_AGENTS } from "./orch-agents";
import { resolveClaude, type ClaudeCmd } from "./claude-bin";

const USAGE = `YAAIORCH (Yet Another AI Orchestrator) CLI. Run from the target repo root.
  orch run "<goal>"     one goal, loops architect -> build -> QA until QA passes
  orch add "<goal>"     queue a goal
  orch loop             process the queue continuously (Ctrl+C stops after current goal)
  orch status           show queue
  orch agents           list agents + skills the architect will see
  orch doctor [--json]  check node, claude (installed, logged in), git and the repo
  orch stop-after        a running loop stops before its next goal (the current one finishes)
  orch learn             study the repo (read-only) and write .orchestrator/brief.md for later goals
  orch plugins [--json] [--details]  Claude Code plugins installed for this repo (--details: token cost)
  orch rollback [BRANCH]  reset to the latest (or given) checkpoint; discarded work is kept
                        on an orchestrator/discarded-* branch
  orch prune [--older-than DAYS]  delete orchestrator/* branches older than DAYS (14)
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
         --no-notes   do not use or write .orchestrator/notes.md (lessons from earlier goals, read by the
                  architect); also "notes": false in config
         --strict-files   a file changed outside every task's file list fails the round (default: QA is told)
                  also "strictFiles": true in config
         --max-cost-total USD   loop only: stop before the next goal once the queue has spent this much
                  (each goal also gets at most what is left as its --max-cost); also "maxCostTotal" in config
         --no-brief   do not use or write .orchestrator/brief.md (the architect's notes on the repo,
                  reused across rounds and goals); also "brief": false in config
         --fast   round 1 is one agent doing the whole goal, judged by the checks (QA only if there
                  are no checks); if that fails, later rounds run the full architect/build/QA loop
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
type Task = { agent: string; phase: Phase; task: string; files?: string[]; heavy?: boolean; figma?: string; skills?: string[] };
/** `brief`: the architect's project brief, when there was none yet or the old one was wrong. */
type Plan = { summary: string; tasks: Task[]; brief?: string };
type Verdict = { passed: boolean; failures: string[]; notes?: string[] };
/** The plan critic's answer. */
type Review = { approved: boolean; issues: string[] };
/** `note` says why a pending goal is waiting (for example a usage-limit reset). */
type Item = { id: number; goal: string; status: "pending" | "running" | "done" | "failed"; note?: string };
type Entry = { name: string; description: string; builtin?: boolean };
type Result = { agent: string; out: string; touched: string[]; cost: number; error?: string; fatal?: Error; status?: string };

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
function frontmatter(path: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, "utf8"));
  const out: Record<string, string> = {};
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const roots = () => [join(homedir(), ".claude"), join(process.cwd(), ".claude")];

function discoverAgents(): Entry[] {
  const found = new Map<string, Entry>();
  for (const [name, a] of Object.entries(BUILTIN_AGENTS)) found.set(name, { name, description: a.description, builtin: true });
  for (const r of roots()) {
    const d = join(r, "agents");
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".md"))) {
      const fm = frontmatter(join(d, f));
      const name = fm.name ?? basename(f, ".md");
      found.set(name, { name, description: (fm.description ?? "").slice(0, 160) }); // later roots override earlier ones
    }
  }
  return [...found.values()];
}

/** Write the built-in agents still in use to the file passed to `claude --agents`. */
function writeBuiltins(roster: Entry[]) {
  const defs = Object.fromEntries(roster.filter((a) => a.builtin).map((a) => [a.name, BUILTIN_AGENTS[a.name]]));
  mkdirSync(DIR, { recursive: true });
  writeFileSync(BUILTIN_FILE, JSON.stringify(defs, null, 2));
}

function discoverSkills(): Entry[] {
  const found = new Map<string, Entry>();
  for (const r of roots()) {
    const d = join(r, "skills");
    if (!existsSync(d)) continue;
    for (const s of readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const p = join(d, s.name, "SKILL.md");
      if (!existsSync(p)) continue;
      const fm = frontmatter(p);
      found.set(fm.name ?? s.name, { name: fm.name ?? s.name, description: (fm.description ?? "").slice(0, 120) });
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

// ---------- claude runner (prompt via stdin: no quoting problems on Windows) ----------
type CliResult = { result?: unknown; is_error?: boolean; subtype?: string; total_cost_usd?: number };
/**
 * Money spent on one goal; `cap` is the --max-cost limit. Each agent call reserves its share of what is
 * left before it starts (`reserved`), so parallel calls cannot overspend together; `launching` counts the
 * calls of a parallel batch that have not started yet, so they get equal shares.
 */
type Budget = { spent: number; cap?: number; reserved: number; launching: number };

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
type RunCtx = { budget: Budget; timeoutMs: number; usageCap: UsageCap; onLimit: "wait" | "stop"; repoContext?: string };

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

async function run(agent: Entry, model: string, prompt: string, ctx: RunCtx, readOnly: boolean): Promise<{ text: string; cost: number }> {
  for (let attempt = 1; ; attempt++) {
    await respectUsageCap(ctx);
    try {
      return await runOnce(agent, model, prompt, ctx, readOnly);
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
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (j?.type === "rate_limit_event") changed = readUsage(j) || changed;
      else if (j?.type === "result" || (j && "total_cost_usd" in j)) r = j;
    } catch {
      /* not a JSON line */
    }
  }
  if (changed) emit("usage", { ...usage });
  return r;
}

async function runOnce(agent: Entry, model: string, prompt: string, ctx: RunCtx, readOnly: boolean): Promise<{ text: string; cost: number }> {
  const { budget } = ctx;
  if (budget.cap !== undefined && budget.spent >= budget.cap) throw new BudgetExceeded(`budget of ${usd(budget.cap)} used up (${usd(budget.spent)} spent)`);
  const ceiling = await reserve(budget);
  let released = false;
  /** Give the reservation back and count what the call cost (once, however the call ends). */
  const settle = (cost: number) => {
    if (released) return;
    released = true;
    if (ceiling !== undefined) budget.reserved = Math.max(0, budget.reserved - ceiling);
    budget.spent += cost;
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
      settle(cost);
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
      resolve({ text: r.result, cost });
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
    for (const f of t.files ?? []) {
      const why = badPath(f);
      if (why) throw new Error(`task ${i} (${t.agent}): file "${f}" ${why}`);
      const k = normPath(f);
      if (owner.has(k)) throw new Error(`file ${f} owned by both ${owner.get(k)} and ${t.agent}`);
      owner.set(k, t.agent);
    }
  });
  if (!plan.tasks.some((t) => t.phase === "verify")) throw new Error("plan has no verify task");
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

/** Refuse a dirty tree, then create the rollback branch. Returns "" outside git. */
function prepareGit(): string {
  if (!isGitRepo()) {
    console.warn("warning: not a git repo; no checkpoint, no commits, no diff checks");
    return "";
  }
  if (!hasCommits()) throw new Error("the git repo has no commits yet; make an initial commit first");
  const dirty = dirtyFiles();
  if (dirty) throw new Error(`working tree has uncommitted changes; commit or stash them first, or run "orch rollback" after a stopped run:\n${dirty}`);
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
};

/** Run one build task; trust the diff, not the report. Re-dispatch once on phantom completion. */
async function execute(t: Task, agent: Entry, model: string, ctx: RunCtx): Promise<Result> {
  const prompt =
    (ctx.repoContext ? `${ctx.repoContext}## Your task\n` : "") +
    (t.files?.length ? `${t.task}\n\nYour files (touch only these):\n${t.files.map((f) => `- ${f}`).join("\n")}` : t.task) +
    (t.figma ? `\n\nFigma: ${t.figma}` : "") +
    (t.skills?.length ? `\n\nBefore starting, load these skills with the Skill tool: ${t.skills.join(", ")}` : "") +
    TASK_FORMAT;
  let cost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = new Map((t.files ?? []).map((f) => [f, sig(f)]));
    const r = await run(agent, model, prompt, ctx, false);
    cost += r.cost;
    const touched = (t.files ?? []).filter((f) => sig(f) !== before.get(f));
    if (!t.files?.length || touched.length || !/Status:\s*COMPLETE/i.test(r.text)) return { agent: t.agent, out: r.text, touched, cost };
    console.warn(`phantom completion by ${t.agent}; re-dispatching`);
  }
  return { agent: t.agent, out: "PHANTOM: no diff after 2 attempts", touched: [], cost };
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

type LastRun = { goal: string; status: "running" | "passed" | "failed"; checkpoint?: string; cost: number; state: unknown[] };

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
    emit("learn_end", { ok, cost: round4(ctx.budget.spent) });
    console.log(`cost: ${usd(ctx.budget.spent)}${o.maxCost !== undefined ? ` of ${usd(o.maxCost)}` : ""}`);
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
  let all = (existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, "utf8").trim() + "\n\n" : "# Notes from earlier goals\n\n") + entry;
  while (all.length > MAX_NOTES) {
    const i = all.indexOf("\n## ", all.indexOf("## ") + 3); // drop the oldest entry, keep the heading
    if (i < 0) break;
    all = all.slice(0, all.indexOf("## ")) + all.slice(i + 1);
  }
  writeFileAtomic(NOTES_FILE, all);
}

/** The plan critic: a read-only review of the plan before anything is built. Non-fatal errors approve the plan. */
async function critique(critic: Entry, goal: string, plan: Plan, brief: string | null, model: string, ctx: RunCtx): Promise<Review & { cost: number }> {
  const prompt =
    `Goal: ${goal}\n\n` +
    (brief ? `Project brief:\n${brief}\n\n` : "") +
    `Plan to review:\n${JSON.stringify({ summary: plan.summary, tasks: plan.tasks }, null, 2)}` +
    REVIEW_FORMAT;
  try {
    const r = await run(critic, model, prompt, ctx, true);
    return { ...asReview(extractJson<Review>(r.text)), cost: r.cost };
  } catch (e) {
    if (isFatal(e)) throw e;
    console.warn(`plan critic failed (${msg(e)}); going on with the plan`);
    return { approved: true, issues: [], cost: 0 };
  }
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
async function runGoal(goal: string, o: Opts): Promise<boolean> {
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
  });
  const ctx: RunCtx = {
    budget: { spent: 0, cap: o.maxCost, reserved: 0, launching: 0 },
    timeoutMs: o.agentTimeoutMs,
    usageCap: o.usageCap,
    onLimit: o.onLimit,
  };
  const lr: LastRun = { goal, status: "running", cost: 0, state: [] };
  goalNotes = [];
  let cp = "";
  let passed = false;
  let interrupted = false;
  try {
    cp = o.dryRun ? "" : prepareGit();
    lr.checkpoint = cp || undefined;
    if (!o.dryRun) writeLastRun(lr); // the UI offers rollback from this even if the run is killed in round 1
    passed = await runGoalInner(goal, o, cp, ctx, lr);
    emit("goal_end", { passed, cost: round4(ctx.budget.spent) });
    if (o.notes && !o.dryRun) {
      const rounds = lr.state as { failures: string[] }[];
      appendNotes(goal, passed, rounds.length, goalNotes, rounds[0]?.failures ?? [], rounds.at(-1)?.failures ?? []);
    }
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
      ...(e instanceof UsageLimit ? { usageLimit: true, resetAt: e.resetAt } : {}),
    });
    throw e;
  } finally {
    lastGoalCost = ctx.budget.spent;
    if (cp) finishGit(cp, goal, passed, o.park || (interrupted && o.onLimit === "wait"), interrupted);
    console.log(`cost: ${usd(ctx.budget.spent)}${o.maxCost !== undefined ? ` of ${usd(o.maxCost)}` : ""}`);
    if (!o.dryRun) {
      lr.status = passed ? "passed" : "failed";
      lr.cost = round4(ctx.budget.spent);
      lr.checkpoint = cp && branchExists(cp) ? cp : undefined;
      writeLastRun(lr);
    }
  }
}

async function runGoalInner(goal: string, o: Opts, cp: string, ctx: RunCtx, lr: LastRun): Promise<boolean> {
  const roster = discoverAgents();
  const byName = new Map(roster.map((a) => [a.name, a]));
  const architect = byName.get("architect")!; // always present: built-in unless overridden
  // The critic reviews plans; it is never given build or verify tasks.
  const workers = roster.filter((a) => a.name !== "architect" && a.name !== "critic");
  const critic = byName.get("critic");
  const skills = discoverSkills();
  writeBuiltins(roster);
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  const checks = loadChecks(cfg);
  writeAgentSettings(cfg, checks, o.plugins);
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
  let note = "";
  let stuck = 0;
  let previous = "";
  /** Per-task escalation: agents moved up on their own after a stuck round (tier, and models with aliases stepped up). */
  const agentPower = new Map<string, Power>();
  const agentModels = new Map<string, Models>();

  for (let round = 1; round <= o.maxRounds; round++) {
    const spentBefore = ctx.budget.spent;
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
        emit("critic", { round, approved: review.approved, issues: review.issues, revised, cost: round4(review.cost) });
      }
    }
    // After planning, so a brief the architect just wrote reaches this round's agents. The fast path's task has them already.
    ctx.repoContext = direct ? "" : repoContext(o.brief ? readBrief() : "", notes);
    console.log(`plan: ${plan.summary}\n` + plan.tasks.map((t) => `  [${t.phase}] ${t.agent}: ${t.task.slice(0, 70)}`).join("\n"));
    emit("plan", { round, summary: plan.summary, cost: round4(planCost), tasks: plan.tasks.map((t, id) => ({ id, ...t })) });
    if (o.dryRun) return true;

    const idOf = new Map(plan.tasks.map((t, id) => [t, id]));
    const statuses = new Map<Task, string>();
    const skip = (t: Task) => (
      statuses.set(t, "SKIPPED"),
      emit("task_end", { round, id: idOf.get(t)!, agent: t.agent, phase: t.phase, status: "SKIPPED", touched: [] })
    );
    /** Never throws: a failed task becomes a failure for the next round, and its siblings run to the end. */
    const exec = async (t: Task): Promise<Result> => {
      const id = idOf.get(t)!;
      emit("task_start", { round, id, agent: t.agent, phase: t.phase });
      try {
        const role: Role = t.agent === "dev" ? "dev" : t.heavy ? "heavy" : "impl";
        const model = modelFor(agentPower.get(t.agent) ?? power, agentModels.get(t.agent) ?? models, role, t.agent);
        const r = await execute(t, byName.get(t.agent)!, model, ctx);
        const status = /Status:\s*(COMPLETE|PARTIAL|FAILED)/i.exec(r.out)?.[1]?.toUpperCase() ?? (r.out.startsWith("PHANTOM") ? "PHANTOM" : "UNKNOWN");
        statuses.set(t, status);
        emit("task_end", { round, id, agent: t.agent, phase: t.phase, status, touched: r.touched, cost: round4(r.cost) });
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
    const committed = cp ? tryCommit(`orch: ${short(goal)} (round ${round})`) : null;
    const progressed = cp ? !!committed || !!dirtyFiles() : results.some((r) => r.touched.length > 0);
    // Budget or usage limit: siblings have finished and the work is committed; end the goal.
    const fatal = results.find((r) => r.fatal)?.fatal;
    if (fatal) {
      verify.forEach(skip);
      throw fatal;
    }

    const verdicts: Verdict[] = [];
    let checkResults: Check[] = [];
    if (foundationFailed)
      verify.forEach(skip); // building on a broken foundation is pointless to verify
    else {
      checkResults = runChecks(checks);
      emit("checks", { round, results: checkResults.map(({ name, command, ok, code, ms }) => ({ name, command, ok, code, ms })) });
      const report = results.map((r) => `[${r.agent}] ${r.out}`).join("\n");
      const diff =
        (cp ? `\n\nChanges since the checkpoint:\n${diffSummary(cp)}` : "") +
        (unowned.length ? `\n\nFiles changed outside every task's file list (check that each was needed and is correct):\n- ${unowned.join("\n- ")}` : "") +
        checkReport(checkResults);
      for (const t of verify) {
        const id = idOf.get(t)!;
        emit("task_start", { round, id, agent: t.agent, phase: t.phase });
        try {
          const r = await run(
            byName.get(t.agent)!,
            modelFor(power, models, "qa", t.agent),
            `${ctx.repoContext ?? ""}Goal: ${goal}\n${t.task}\n\nImplementer reports:\n${report}${diff}${VERDICT_FORMAT}`,
            ctx,
            true,
          );
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
          });
          verdicts.push(v);
        } catch (e) {
          emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: "ERROR", error: msg(e), touched: [] });
          if (isFatal(e)) throw e;
          verdicts.push({ passed: false, failures: [`${t.agent} could not verify: ${msg(e)}`] });
        }
      }
    }

    // Exit codes beat opinions: a failed check fails the round whatever QA says.
    const checkFailures = checkResults.filter((c) => !c.ok).map((c) => `check "${c.name}" failed (\`${c.command}\`, exit ${c.code}):\n${c.output.slice(-800)}`);
    // A plan without verify tasks (fast path with checks) is judged by the checks alone; at least one must have run.
    const verifiedBy = verify.length ? verdicts.length > 0 && verdicts.every((v) => v.passed) : checkResults.length > 0;
    const passed = !errors.length && !checkFailures.length && verifiedBy && !(o.strictFiles && unowned.length);
    const prevKey = failureKey(failures);
    const ownershipFailures =
      o.strictFiles && unowned.length
        ? [`files changed outside every task's file list: ${unowned.join(", ")}. Give them to a task in the plan, or have their changes reverted.`]
        : [];
    failures = [...errors, ...checkFailures, ...ownershipFailures, ...verdicts.flatMap((v) => v.failures)];
    const roundCost = round4(ctx.budget.spent - spentBefore);
    const checkSummary = checkResults.map(({ name, ok, code }) => ({ name, ok, code }));
    lr.state.push({ round, power, plan: plan.summary, touched: results.flatMap((r) => r.touched), checks: checkSummary, passed, failures, cost: roundCost });
    lr.cost = round4(ctx.budget.spent);
    writeLastRun(lr);

    emit("round_end", { round, passed, failures, cost: roundCost });
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
    } else {
      stuck = 0;
      note = "";
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

async function loop(o: Opts, pollSec: number, untilEmpty: boolean) {
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
    const item = updateQueue((q) => {
      const next = q.find((i) => i.status === "pending");
      if (next) {
        next.status = "running";
        delete next.note;
      }
      return next && { ...next };
    });
    if (!item) {
      if (untilEmpty) break;
      await sleep(pollSec * 1000);
      continue;
    }
    console.log(`\n##### goal #${item.id}: ${item.goal}`);
    emit("queue_item", { id: item.id, goal: item.goal });
    let outcome: "done" | "failed" | "limit" = "failed";
    let resetAt: number | undefined;
    try {
      // With a loop budget, a goal may spend at most what is left of it (and its own --max-cost, if lower).
      const left = o.maxCostTotal === undefined ? undefined : o.maxCostTotal - spentTotal;
      const goalOpts = left === undefined ? o : { ...o, maxCost: Math.min(o.maxCost ?? Infinity, left) };
      lastGoalCost = 0;
      try {
        outcome = (await runGoal(item.goal, goalOpts)) ? "done" : "failed";
      } finally {
        spentTotal += lastGoalCost;
      }
    } catch (e) {
      if (e instanceof UsageLimit) {
        outcome = "limit";
        resetAt = e.resetAt;
      } else console.error(process.env.ORCH_DEBUG ? e : `Error: ${msg(e)}`);
    }
    const until = outcome === "limit" ? waitUntil(resetAt) : 0;
    updateQueue((q) => {
      // Edited under the queue lock: goals added meanwhile stay.
      const cur = q.find((i) => i.id === item.id);
      if (!cur) return;
      // A usage limit is not the goal's fault: put it back and try again after the reset.
      cur.status = outcome === "limit" ? "pending" : outcome;
      if (outcome === "limit")
        cur.note =
          o.onLimit === "stop"
            ? `usage limit: stopped; resets ${resetAt ? new Date(resetAt).toLocaleString() : "later"}`
            : `usage limit: retrying after ${new Date(until).toLocaleString()}`;
    });
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
      critic: { type: "boolean", default: false },
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
        for (;;) {
          try {
            process.exit((await runGoal(goal, o)) ? 0 : 1);
          } catch (e) {
            // The interrupted work was moved to orchestrator/interrupted-*, so the retry starts clean.
            if (e instanceof UsageLimit && o.onLimit === "wait") await waitForReset(e);
            else throw e;
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
          .map((i) => `#${i.id} [${i.status}] ${i.goal}`)
          .join("\n") || "queue empty",
      );
    case "agents":
      console.log(
        "agents:\n" +
          discoverAgents()
            .map((a) => `  ${a.name}${a.builtin ? " (built-in)" : ""}: ${a.description}`)
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
export { validate, extractJson, parseReset, failureKey, badPath, normPath, asVerdict, asReview, TRANSIENT_RE };

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
