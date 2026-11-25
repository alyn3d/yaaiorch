// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

// `orch group run`: one goal across a group's backend and frontend repo. The group process holds the group lock and
// both repos' run locks, checkpoints both repos, asks the coordinator for the contract and one goal per repo, builds
// both repos in parallel (each an `orch run` child under the held lock), then checks the frontend against the running
// backend (integration, with coordinator fault calls and fix rounds), and ends by dropping the checkpoints (pass) or
// parking each repo's work and resetting it (fail, usage limit, stop). Bundled into orch.mjs.
//
// It must not import orch.ts (orch.ts imports it): the lock and atomic-write helpers come in as `GroupDeps`. Every
// repo-level git step runs as `orch group-member ...` in that repo, so this file never touches a repo itself.
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DevServer, type ServeConfig } from "./orch-browser";
import type { OrchEvent, OrchEventData, OrchEventType } from "./orch-events";
import {
  checkGroupName,
  groupEnv,
  groupSection,
  groupServe,
  groupsDir,
  memberOf,
  parseGroupPlan,
  type FaultCall,
  type GroupConfig,
  type GroupPlan,
  type GroupRepo,
  type GroupRole,
} from "./orch-group";

export type GroupOpts = {
  maxCost?: number;
  power: string;
  model?: string;
  approvePlan: boolean;
  /** Minutes, as --agent-timeout. */
  agentTimeout: number;
  /** The build children's fast path: undefined keeps each repo's own default. */
  fast?: boolean;
  maxRounds?: number;
};
export type GroupOutcome = "pass" | "fail" | "limit" | "stopped";
export type GroupDeps = {
  acquireRunLock: (cmd: string, root: string, file?: string) => string;
  releaseRunLock: (id: string, root: string, file?: string) => void;
  writeFileAtomic: (path: string, data: string) => void;
};
/** Exit codes of `orch group run`. */
export const GROUP_EXIT: Record<GroupOutcome, number> = { pass: 0, fail: 1, limit: 3, stopped: 130 };

type Event = Record<string, unknown> & { type: string };
type Checkpoint = { branch: string; head: string };
type GroupDecision = { round: number; action: "approve" | "reject"; note?: string; plan?: GroupPlan };

const ROLES: GroupRole[] = ["backend", "frontend"];
/** The branch `group-member checkpoint` creates (orch.ts GROUP_CHECKPOINT). */
const GROUP_CHECKPOINT = "orchestrator/group-checkpoint-";

export const groupDir = (name: string) => join(groupsDir(), checkGroupName(name));
const STOP_FILE = "stop";
const PENDING = "plan-pending.json";
const DECISION = "plan-decision.json";

/** How to start this orch again: the same Node.js flags (tsx's loader when run from source) and script. */
export const selfArgs = (): string[] => [...process.execArgv, resolve(process.argv[1] ?? "")];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emit<K extends OrchEventType>(type: K, data: OrchEventData[K]) {
  if (process.env.ORCH_EVENTS) console.log("@@ORCH@@ " + JSON.stringify({ type, t: Date.now(), ...data }));
}

// ---------- children: every process the group starts, so it can kill or await them all ----------
const live = new Set<{ p: ChildProcess; done: Promise<number> }>();
/** The backend's server during the integration step: killed with the children, on every exit path. */
let backendServer: DevServer | undefined;

/** Kill a child and everything it started: taskkill /T on Windows, the child's process group elsewhere (it runs detached). */
function killChildTree(p: ChildProcess) {
  if (!p.pid || p.exitCode !== null || p.signalCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-p.pid, "SIGKILL");
  } catch {
    try {
      p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
const killAll = () => {
  for (const c of live) killChildTree(c.p);
  backendServer?.stop();
};
/** Kill every child and wait until each has exited, so nothing runs in a repo once its lock is released. */
async function settleChildren() {
  killAll();
  await Promise.all([...live].map((c) => c.done));
}

type Spawned = { done: Promise<number>; kill(): void };

function spawnOrch(cwd: string, args: string[], env: Record<string, string>, onLine: (line: string, stream: "out" | "err") => void, input?: string): Spawned {
  const p = spawn(process.execPath, [...selfArgs(), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  if (input !== undefined) p.stdin!.end(input);
  createInterface({ input: p.stdout! }).on("line", (l) => onLine(l, "out"));
  createInterface({ input: p.stderr! }).on("line", (l) => onLine(l, "err"));
  const entry = {
    p,
    done: new Promise<number>((ok) => {
      p.on("error", (e) => {
        onLine(`could not start: ${msg(e)}`, "err");
        ok(1);
      });
      p.on("close", (code) => ok(code ?? 1));
    }),
  };
  live.add(entry);
  void entry.done.then(() => live.delete(entry));
  return { done: entry.done, kill: () => killChildTree(p) };
}

/**
 * Start `orch <args>` in a member repo under the group's lock (env carries ORCH_GROUP_LOCK). Its events go to
 * `onEvent`; its other output goes to the group's stderr as `[<role>] ...`, keeping stdout for the group's own events.
 */
export function runChild(repo: GroupRepo, args: string[], env: Record<string, string>, onEvent: (e: Event) => void): Spawned {
  return spawnOrch(repo.path, args, { ...env, ORCH_EVENTS: "1" }, (line) => {
    if (line.startsWith("@@ORCH@@ ")) {
      try {
        return onEvent(JSON.parse(line.slice(9)) as Event);
      } catch {
        /* not an event after all: print it */
      }
    }
    process.stderr.write(`[${repo.role}] ${line}\n`);
  });
}

/** `orch group-member ...` in a repo: the last stdout line is its JSON answer. Throws with its stderr on failure. */
async function member(
  repo: GroupRepo,
  lock: string,
  args: string[],
  input?: string,
  label: string = repo.role,
): Promise<Record<string, unknown> & { code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const c = spawnOrch(
    repo.path,
    ["group-member", ...args],
    { ORCH_GROUP_LOCK: lock, ORCH_EVENTS: "" },
    (line, stream) => {
      if (stream === "out") out.push(line);
      else {
        err.push(line);
        process.stderr.write(`[${label}] ${line}\n`);
      }
    },
    input,
  );
  const code = await c.done;
  if (code !== 0) {
    // orch prints "Error: <message>" (possibly over several lines) as its last words.
    const at = err.findLastIndex((l) => l.startsWith("Error: ") || l.startsWith("Stopped: "));
    const text =
      at >= 0
        ? err
            .slice(at)
            .join("\n")
            .replace(/^(Error|Stopped): /, "")
        : err.filter((l) => l.trim()).at(-1);
    const e = new Error(text || `orch group-member ${args[0]} exited with ${code}`) as Error & { code?: number };
    e.code = code;
    throw e;
  }
  const last = out.filter((l) => l.trim()).at(-1) ?? "{}";
  return { ...(JSON.parse(last) as Record<string, unknown>), code };
}

// ---------- checks before anything is locked ----------
function checkMember(r: GroupRepo) {
  if (!existsSync(r.path) || !statSync(r.path).isDirectory()) throw new Error(`group ${r.role} repo ${r.path} does not exist`);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: r.path, encoding: "utf8", windowsHide: true });
  const norm = (p: string) => {
    const real = realpathSync.native(p);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  if (top.status !== 0 || norm(top.stdout.trim()) !== norm(r.path)) throw new Error(`group ${r.role} repo ${r.path} is not the top of a git repo`);
  // The other member gets it as --read-dir, whose deny rules need a local path without pattern characters (memberFlags).
  const real = realpathSync.native(r.path);
  if (/^[\\/]{2}/.test(real)) throw new Error(`group ${r.role} repo ${r.path} is a network (UNC) path; groups need local directories`);
  if (/[[\]*?{}!]/.test(real))
    throw new Error(`group ${r.role} repo ${r.path} has a character that permission rules read as a pattern ([ ] * ? { } !); move or rename it`);
}

const stampNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
};

const readBrief = (r: GroupRepo) => {
  try {
    return readFileSync(join(r.path, ".orchestrator", "brief.md"), "utf8");
  } catch {
    return "";
  }
};

// ---------- the run ----------
type Run = {
  g: GroupConfig;
  goal: string;
  o: GroupOpts;
  deps: GroupDeps;
  dir: string;
  stamp: string;
  locks: Map<GroupRole, string>;
  checkpoints: Partial<Record<GroupRole, Checkpoint>>;
  spent: number;
  stopped: boolean;
  /** Parking or dropping the checkpoints: a stop then is only recorded, so it never kills a park half way. */
  ending: boolean;
  /** How to start the backend for integration (`groupServe`); undefined skips integration. */
  serve?: ServeConfig & { baseUrl?: string };
  plan?: GroupPlan;
};

class Stopped extends Error {}
class Limit extends Error {}

const repoOf = (s: Run, role: GroupRole) => memberOf(s.g, role);

/** last-run.json: `checkpoints` are the start HEADs (role -> sha), which a rollback after a pass resets to. */
function writeLast(s: Run, extra: Record<string, unknown>) {
  const checkpoints = Object.fromEntries(Object.entries(s.checkpoints).map(([role, cp]) => [role, cp.head]));
  const data = { goal: s.goal, stamp: s.stamp, checkpoints, ...extra };
  try {
    s.deps.writeFileAtomic(join(s.dir, "last-run.json"), JSON.stringify(data, null, 2) + "\n");
  } catch (e) {
    console.warn(`warning: could not write the group's last-run.json: ${msg(e)}`);
  }
}

/** Both checkpoints, or none: a refusal in one repo drops the other's. */
async function checkpointAll(s: Run) {
  try {
    for (const role of ROLES) {
      const r = await member(repoOf(s, role), s.locks.get(role)!, ["checkpoint", s.stamp]);
      s.checkpoints[role] = { branch: String(r.checkpoint), head: String(r.head) };
    }
  } catch (e) {
    for (const role of ROLES) {
      const cp = s.checkpoints[role];
      if (cp) await member(repoOf(s, role), s.locks.get(role)!, ["drop", cp.branch]).catch((x) => console.warn(`warning: ${role}: ${msg(x)}`));
    }
    s.checkpoints = {};
    throw e;
  }
}

function budgetLeft(s: Run): number | undefined {
  if (s.o.maxCost === undefined) return undefined;
  const left = s.o.maxCost - s.spent;
  if (!(left > 0.0001)) throw new Error(`the group's --max-cost of $${s.o.maxCost} is used up`);
  return left;
}
/** `--max-cost` for a child: a share that rounds to $0.0000 means the budget is used up (never "--max-cost 0.0000"). */
export function costArgs(amount: number | undefined): string[] {
  if (amount === undefined) return [];
  const fixed = amount.toFixed(4);
  if (!(Number(fixed) > 0)) throw new Error(`the group's --max-cost is used up: this step's share rounds to $${fixed}`);
  return ["--max-cost", fixed];
}

/**
 * Budget policy with --max-cost (`left` is what is left of it when the step starts). The build gets 60% of it,
 * split equally over the repos that build; the other 40% is kept for integration and fix rounds (with no
 * integration, `rounds` 0, the build gets all of it). Integration round r of `rounds` gets what is left divided by
 * the child steps still possible (itself, then a fix and an integration for each later round: 2(rounds-r)+1); a fix
 * in round r gets what is left divided by 2(rounds-r) (itself and the steps after it), split over the repos it fixes.
 */
export function childShare(left: number, step: "build" | "integration" | "fix", children: number, round: number, rounds: number): number {
  const n = Math.max(1, children);
  const later = Math.max(0, rounds - round);
  if (step === "build") return (rounds > 0 ? (left * 3) / 5 : left) / n;
  return left / (step === "integration" ? 2 * later + 1 : Math.max(1, 2 * later)) / n;
}
/** Integration rounds of this run: none without a backend serve. */
const roundsOf = (s: Run) => (s.serve ? (s.g.integrationRounds ?? 2) : 0);
const modelArgs = (o: GroupOpts) => [
  "--power",
  o.power,
  "--agent-timeout",
  String(o.agentTimeout),
  "--on-limit",
  "stop",
  ...(o.model ? ["--model", o.model] : []),
];

/** The coordinator, run in the backend repo with the frontend readable. Exit 3 is a usage limit. */
async function coordinator(s: Run, mode: "plan" | "fault", input: Record<string, unknown>): Promise<{ reply: unknown; cost: number }> {
  const briefs = Object.fromEntries(ROLES.map((r) => [r, readBrief(repoOf(s, r))]).filter(([, b]) => b));
  let r;
  try {
    r = await member(
      repoOf(s, "backend"),
      s.locks.get("backend")!,
      ["coordinate", mode, "--group", s.g.name, ...modelArgs(s.o), ...costArgs(budgetLeft(s))],
      JSON.stringify({ ...input, briefs }),
      "coordinator",
    );
  } catch (e) {
    if (s.stopped) throw new Stopped();
    if ((e as { code?: number }).code === 3) throw new Limit(msg(e));
    throw new Error(`coordinator: ${msg(e)}`, { cause: e });
  }
  const cost = Number(r.cost) || 0;
  s.spent += cost;
  return { reply: r.reply, cost };
}

async function coordinatePlan(s: Run, note?: string): Promise<GroupPlan> {
  const goal = note ? `${s.goal}\n\nThe person reviewing your previous plan rejected it:\n${note}\nWrite a new contract and goals that answer this.` : s.goal;
  const { reply, cost } = await coordinator(s, "plan", { goal });
  const plan = reply as GroupPlan;
  emit("group_plan", { contract: plan.contract, goals: plan.goals, cost });
  return plan;
}

/** The contract in the group dir, in each repo's .orchestrator/contract.md, and the --group-context file per repo. */
function writeContract(s: Run, plan: GroupPlan) {
  s.deps.writeFileAtomic(join(s.dir, "contract.md"), plan.contract + "\n");
  for (const role of ROLES) {
    const r = repoOf(s, role);
    s.deps.writeFileAtomic(join(r.path, ".orchestrator", "contract.md"), plan.contract + "\n");
    const others = s.g.repos.filter((x) => x.role !== role);
    s.deps.writeFileAtomic(join(s.dir, `context-${role}.md`), groupSection(plan.contract, others));
  }
}

/** --approve-plan: show the contract and goals, wait for `orch approve --group NAME` (or a stop). */
async function awaitGroupDecision(s: Run, round: number, plan: GroupPlan): Promise<GroupDecision> {
  const pending = join(s.dir, PENDING);
  const decision = join(s.dir, DECISION);
  rmSync(decision, { force: true });
  s.deps.writeFileAtomic(pending, JSON.stringify({ goal: s.goal, round, contract: plan.contract, goals: plan.goals }, null, 2));
  emit("group_approval_wait", { round, contract: plan.contract, goals: plan.goals });
  console.log(
    `\nwaiting for your approval of the group plan (round ${round}).\n` +
      `  build it: orch approve --group ${s.g.name}   edit it: change ${pending}, then orch approve --group ${s.g.name} --plan-stdin < ${pending}\n` +
      `  send it back: orch approve --group ${s.g.name} --reject "why"`,
  );
  try {
    for (;;) {
      if (s.stopped) throw new Stopped();
      if (existsSync(decision)) {
        let d: GroupDecision | undefined;
        try {
          d = JSON.parse(readFileSync(decision, "utf8")) as GroupDecision;
        } catch {
          /* being written; try again */
        }
        if (d) {
          rmSync(decision, { force: true });
          if (d.round === round) {
            emit("group_approval", { round, action: d.action, ...(d.plan ? { edited: true } : {}) });
            return d;
          }
        }
      }
      await sleep(300);
    }
  } finally {
    rmSync(pending, { force: true });
  }
}

/** The coordinator's plan, re-planned with the reviewer's reason until approved (with --approve-plan). */
async function planStep(s: Run): Promise<GroupPlan> {
  let note: string | undefined;
  for (let round = 1; ; round++) {
    let plan = await coordinatePlan(s, note);
    writeContract(s, plan);
    if (!s.o.approvePlan) return plan;
    const d = await awaitGroupDecision(s, round, plan);
    if (d.action === "approve") {
      if (d.plan) {
        plan = d.plan;
        writeContract(s, plan);
        emit("group_plan", { contract: plan.contract, goals: plan.goals, cost: 0, edited: true });
      }
      console.log("group plan approved");
      return plan;
    }
    note = d.note || "no reason given";
    console.log(`group plan sent back: ${note}`);
  }
}

/** `stopped`: the group killed it after the other child failed, so its exit code says nothing about its own work. */
type ChildEnd = { role: GroupRole; code: number; cost: number; stopped: boolean };

/**
 * The frontend children's env: the group's frontend `env` with "{backend}" replaced by the backend's base URL. Without
 * one (no serve), an entry that still says "{backend}" is left out rather than passed on unreplaced.
 */
function frontendEnv(s: Run): Record<string, string> {
  const base = s.serve ? (s.serve.baseUrl ?? new URL(s.serve.url).origin) : undefined;
  return Object.fromEntries(Object.entries(groupEnv(s.g, base)).filter(([, v]) => !v.includes("{backend}")));
}

/** Run `orch run` children in parallel; the first failure stops the others (their work is parked either way). */
async function runChildren(
  s: Run,
  step: "build" | "integration" | "fix",
  round: number,
  goals: Partial<Record<GroupRole, string>>,
  extra: string[],
  watch?: (role: GroupRole, e: Event) => void,
  info: Record<string, unknown> = {},
): Promise<ChildEnd[]> {
  const roles = ROLES.filter((r) => goals[r]);
  const left = budgetLeft(s);
  const share = left === undefined ? undefined : childShare(left, step, roles.length, round, roundsOf(s));
  const started = roles.map((role) => {
    const repo = repoOf(s, role);
    const others = s.g.repos.filter((x) => x.role !== role);
    emit("group_step", { step, repo: role, round, ...info });
    let cost = 0;
    // The goal goes last, after "--": a goal that starts with "-" (a markdown list) is never read as an option.
    const args = [
      "run",
      "--group-context",
      join(s.dir, `context-${role}.md`),
      ...others.flatMap((x) => ["--read-dir", x.path]),
      "--strict-files",
      "--no-commands",
      ...modelArgs(s.o),
      ...costArgs(share),
      ...(s.o.maxRounds ? ["--max-rounds", String(s.o.maxRounds)] : []),
      ...extra,
      "--",
      goals[role]!,
    ];
    // The frontend's env reaches everything its child starts (checks, dev server, browser checks); the lock id wins.
    const env = { ...(role === "frontend" ? frontendEnv(s) : {}), ORCH_GROUP_LOCK: s.locks.get(role)! };
    const c = runChild(repo, args, env, (event) => {
      if (event.type === "goal_end" && typeof event.cost === "number") cost = event.cost;
      watch?.(role, event);
      // Passed on as the child printed it: the child is this same orch, so it is one of the OrchEvent shapes.
      emit("group_child", { repo: repo.path, role, event: event as unknown as OrchEvent });
    });
    return { role, c, cost: () => cost, stopped: false };
  });
  const ends = await Promise.all(
    started.map(async (me) => {
      const code = await me.c.done;
      if (code !== 0 && !me.stopped)
        for (const x of started)
          if (x !== me) {
            x.stopped = true;
            x.c.kill();
          }
      return { role: me.role, code, cost: me.cost(), stopped: me.stopped };
    }),
  );
  for (const e of ends) s.spent += e.cost;
  return ends;
}

/**
 * After a step's children: every member's tree must be clean. A run commits its own work, so an uncommitted change is
 * a write it did not make (an agent writing into the other repo past the deny rules) or a commit that failed. Throws
 * naming the files; the group then parks them with the rest.
 */
async function checkTrees(s: Run, step: "build" | "integration" | "fix") {
  const found = await Promise.all(
    ROLES.map(async (role) => {
      const r = await member(repoOf(s, role), s.locks.get(role)!, ["head"]);
      const files = Array.isArray(r.dirty) ? r.dirty.map(String) : [];
      return files.length ? `${role}: ${files.slice(0, 20).join(", ")}${files.length > 20 ? ` and ${files.length - 20} more` : ""}` : "";
    }),
  );
  const dirty = found.filter(Boolean);
  if (dirty.length)
    throw new Error(`uncommitted changes after the ${step} (written outside a member run's own commits, e.g. into the other repo): ${dirty.join("; ")}`);
}

/** The last `n` characters: a failure report part stays bounded however much a child printed. */
const clip = (t: string, n = 4000) => (t.length > n ? `…${t.slice(-n)}` : t);
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

/** What an integration child found: from its round_end, checks, visual and goal_end events (never its env). */
type Findings = { failures: string[]; checks: string[]; problems: string[]; error?: string };
function noteFinding(f: Findings, e: Event) {
  if (e.type === "round_end" && Array.isArray(e.failures)) f.failures = e.failures.map(String);
  else if (e.type === "checks" && Array.isArray(e.results))
    f.checks = (e.results as { name?: unknown; command?: unknown; ok?: unknown; code?: unknown }[])
      .filter((x) => !x.ok)
      .map((x) => `${String(x.name)} (\`${String(x.command)}\`) exited ${String(x.code)}`);
  else if (e.type === "visual" && Array.isArray(e.problems)) f.problems = e.problems.map(String);
  else if (e.type === "goal_end" && typeof e.error === "string") f.error = e.error;
}

/** The failure report for the coordinator's fault call, each part bounded. */
function integrationReport(f: Findings, code: number, serverTail: string): string {
  const parts = [`The frontend's integration run failed (exit code ${code}).`];
  if (f.failures.length) parts.push(`QA and check failures:\n${clip(bullets(f.failures))}`);
  if (f.checks.length) parts.push(`Failing checks:\n${clip(bullets(f.checks))}`);
  if (f.problems.length) parts.push(`Browser check problems:\n${clip(bullets(f.problems))}`);
  if (f.error) parts.push(`Run error: ${clip(f.error)}`);
  parts.push(`Backend server output (last lines):\n${clip(serverTail)}`);
  return parts.join("\n\n");
}

/** Throws Stopped, Limit or a failure for children that did not all pass. */
function childrenPassed(s: Run, ends: ChildEnd[], what: string) {
  if (s.stopped) throw new Stopped();
  if (ends.some((e) => e.code === 3)) throw new Limit("a member run hit the Claude usage limit");
  const failed = ends.filter((e) => e.code !== 0 && !e.stopped);
  if (failed.length) throw new Error(`${what} failed in ${failed.map((e) => e.role).join(" and ")}`);
}

/**
 * Step 4: start the backend (in the backend repo) and run the frontend against it. On a failure the coordinator says
 * who is at fault (and may revise the contract), the fix goals run, and integration runs again, at most
 * `integrationRounds` times. Returns on a pass; throws on a failure, a usage limit or a stop.
 *
 * With a serve command the group checks only a backend it started itself: something already answering at the URL fails
 * the step (it would not be the code just built). Without one the person runs the backend: an answering server is used
 * (`external`), and a backend fix fails the group, since the group cannot restart that server to check the fix.
 */
/**
 * The integration child's goal. Its agents get the probe tool (`--probe`) for the running backend: every contract case
 * must be checked live through it, and a check that could not run is a failure, so integration never passes on code
 * reading alone.
 */
export function integrationGoal(base: string): string {
  return (
    `Verify the frontend works against the running backend at ${base} for this contract; fix the frontend if it does not. ` +
    `Call the backend with the mcp__probe__request tool (it reaches only that backend) for every endpoint and case the frontend relies on, ` +
    `and compare each status and body with the contract and with what the frontend expects. ` +
    `Report each call you made and what came back. A case you could not check live is a failure, not a pass.`
  );
}

async function integrationStep(s: Run): Promise<void> {
  if (!s.serve) {
    console.warn("warning: no serve configured for the backend (in the group or the backend repo's config): integration skipped");
    emit("group_step", { step: "integration", round: 1, skipped: "no serve" });
    return;
  }
  const rounds = roundsOf(s);
  const be = repoOf(s, "backend");
  const server = new DevServer(s.serve, { cwd: be.path });
  backendServer = server;
  const owned = !!s.serve.command;
  let external = false;
  /** Null once the backend answers, else why not; throws when the URL answers but not from a server the group started. */
  const start = async (round: number): Promise<string | null> => {
    if (!server.running && (await server.answering())) {
      if (owned) {
        const why = `something already answers at ${server.url}; stop it so the group can start the backend it just built`;
        emit("group_step", { step: "integration", round, failed: why });
        throw new Error(why);
      }
      if (!external)
        console.warn(
          `warning: the backend at ${server.url} was not started by the group (no serve.command): integration runs against it as it is, ` +
            `so restart it yourself if it does not reload the code the group just built`,
        );
      external = true;
    }
    return server.ensure().catch((e: unknown) => `could not start the backend: ${msg(e)}`);
  };
  try {
    let down: string | null | undefined;
    for (let round = 1; ; round++) {
      if (down === undefined) down = await start(round);
      if (s.stopped) throw new Stopped();
      let report: string;
      if (down) {
        console.warn(`integration round ${round}: the backend is not up: ${down.split("\n")[0]}`);
        emit("group_step", { step: "integration", round, failed: "the backend did not come up" });
        report = `The backend did not come up, so the frontend was not checked against it:\n${clip(down)}`;
      } else {
        const base = s.serve.baseUrl ?? new URL(server.url).origin;
        const goal = integrationGoal(base);
        const findings: Findings = { failures: [], checks: [], problems: [] };
        const ends = await runChildren(
          s,
          "integration",
          round,
          { frontend: goal },
          ["--no-fast", "--probe", base],
          (_, e) => noteFinding(findings, e),
          external ? { external: true } : {},
        );
        if (s.stopped) throw new Stopped();
        const [end] = ends;
        if (end.code === 3) throw new Limit("a member run hit the Claude usage limit");
        // Also before a pass: nothing may be left uncommitted in either repo.
        await checkTrees(s, "integration");
        if (end.code === 0) {
          console.log(`integration round ${round}: the frontend works against the running backend`);
          return;
        }
        report = integrationReport(findings, end.code, server.tail());
      }
      if (round >= rounds) throw new Error(`integration failed after ${rounds} round${rounds === 1 ? "" : "s"}: ${report.split("\n")[0]}`);
      const call = await coordinateFault(s, report);
      // The group's backend is stopped while the backend is fixed (its port and files are free), then started again.
      if (call.goals.backend) await server.stopAndWait();
      const ends = await runChildren(s, "fix", round, call.goals, ["--no-fast"]);
      childrenPassed(s, ends, "fix");
      await checkTrees(s, "fix");
      if (call.goals.backend && !owned) throw new Error("backend changed; restart your backend and rerun");
      // A fixed backend starts again; otherwise the next round checks the one running.
      down = call.goals.backend ? await start(round + 1) : undefined;
    }
  } finally {
    server.stop();
    backendServer = undefined;
  }
}

/** After a failed integration: who is at fault and the fix goal for each; a revised contract is rewritten everywhere. */
async function coordinateFault(s: Run, report: string): Promise<FaultCall> {
  const { reply, cost } = await coordinator(s, "fault", { goal: s.goal, contract: s.plan!.contract, report });
  const call = reply as FaultCall;
  const sides: GroupRole[] = call.fault === "both" ? ROLES : [call.fault];
  // parseFaultCall keeps only the goals of the side(s) at fault; this holds even for a reply that did not go through it.
  const goals = Object.fromEntries(sides.filter((r) => call.goals[r]).map((r) => [r, call.goals[r]!])) as Partial<Record<GroupRole, string>>;
  console.log(`coordinator: integration fault is the ${call.fault === "both" ? "backend's and the frontend's" : `${call.fault}'s`}`);
  emit("group_fault", { fault: call.fault, goals, cost, ...(call.contract ? { revised: true } : {}) });
  if (call.contract) {
    s.plan = { contract: call.contract, goals: s.plan!.goals };
    writeContract(s, s.plan);
    emit("group_plan", { contract: call.contract, goals, cost: 0, revised: true });
  }
  return { fault: call.fault, goals, ...(call.contract ? { contract: call.contract } : {}) };
}

/**
 * Pass: drop both checkpoints. Otherwise park each repo's work on orchestrator/<kind>-group-<stamp>, reset to the
 * checkpoint and drop it (the repo is back where it started); a checkpoint whose park failed is kept.
 */
async function endStep(s: Run, ok: boolean, kind: "failed" | "interrupted", reason?: string): Promise<void> {
  const parked: Partial<Record<GroupRole, string | null>> = {};
  /** Repos whose park failed: their group checkpoint stays, and `orch group rollback` resets them to it. */
  const kept: Partial<Record<GroupRole, string>> = {};
  const heads: Partial<Record<GroupRole, string>> = {};
  for (const role of ROLES) {
    const cp = s.checkpoints[role];
    if (!cp) continue;
    const repo = repoOf(s, role);
    let step = ok ? "drop" : "park";
    try {
      if (ok) {
        await member(repo, s.locks.get(role)!, ["drop", cp.branch]);
        // Where the group run ended: a later rollback tells the commits after it (the person's own) from the run's.
        heads[role] = String((await member(repo, s.locks.get(role)!, ["head"]).catch(() => ({ head: "" }))).head) || undefined;
      } else {
        const r = await member(repo, s.locks.get(role)!, ["park", cp.branch, kind]);
        parked[role] = (r.parked as string | null) ?? null;
        step = "drop";
        await member(repo, s.locks.get(role)!, ["drop", cp.branch]);
        console.log(`${role}: ${parked[role] ? `work parked on ${parked[role]}` : "nothing to park"}; reset to ${cp.branch.replace(/^.*\//, "")}`);
      }
    } catch (e) {
      // A park that failed leaves the repo as the run left it; a failed drop after a park leaves only the branch.
      if (!ok && step === "park") kept[role] = cp.branch;
      console.warn(`warning: ${role}: could not ${step} (${cp.branch} kept): ${msg(e)}`);
    }
  }
  const failedPark = Object.keys(kept).length > 0;
  if (failedPark)
    console.log(
      `${Object.keys(kept).join(" and ")}: the work could not be parked, so the repo is as the run left it. ` +
        `Fix the cause above, then reset it to where the group run started with: orch group rollback ${s.g.name}`,
    );
  writeLast(s, { ok, ...(reason ? { reason } : {}), ...(ok ? { heads } : { parked, ...(failedPark ? { kept } : {}) }), ended: Date.now() });
  emit("group_end", { ok, ...(reason ? { reason } : {}), ...(ok ? {} : { parked, ...(failedPark ? { kept } : {}) }) });
}

async function steps(s: Run): Promise<GroupOutcome> {
  await checkpointAll(s);
  writeLast(s, { started: Date.now() });
  const plan = await planStep(s);
  s.plan = plan;
  for (const role of ROLES) if (!plan.goals[role]) console.log(`${role}: nothing to build for this goal`);
  const ends = await runChildren(s, "build", 1, plan.goals, s.o.fast === true ? ["--fast"] : s.o.fast === false ? ["--no-fast"] : []);
  childrenPassed(s, ends, "build");
  await checkTrees(s, "build");
  await integrationStep(s);
  if (s.stopped) throw new Stopped();
  s.ending = true;
  await endStep(s, true, "failed");
  console.log(`group goal done: ${ROLES.filter((r) => plan.goals[r]).join(" and ")} built against the contract`);
  return "pass";
}

/** Signals and `orch group stop`: kill the children; the run then parks both repos as interrupted. */
function watchStop(s: Run): () => void {
  let signals = 0;
  const onSignal = () => {
    if (++signals > 1) {
      // A second signal: no more parking, just get out (exit listeners kill children first, then release locks).
      process.exit(GROUP_EXIT.stopped);
    }
    if (s.ending) {
      // Parking or dropping the checkpoints already: killing that would leave a repo half reset. Let it finish.
      if (!s.stopped) console.log("stop noted: the group is already ending; its repos are being parked or released");
      s.stopped = true;
      return;
    }
    if (!s.stopped) console.log("stopping the group run: the members' work is parked as interrupted");
    s.stopped = true;
    killAll();
  };
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of sigs) process.on(sig, onSignal);
  const stopFile = join(s.dir, STOP_FILE);
  const poll = setInterval(() => {
    if (!s.stopped && existsSync(stopFile)) {
      rmSync(stopFile, { force: true });
      onSignal();
    }
  }, 300);
  poll.unref();
  return () => {
    for (const sig of sigs) process.off(sig, onSignal);
    clearInterval(poll);
  };
}

/** Both repos' run locks and the group's own, as `group run` takes them; `release` frees what was taken. */
function lockGroup(g: GroupConfig, dir: string, deps: GroupDeps) {
  const groupLockFile = join(dir, "run.lock");
  const locks = new Map<GroupRole, string>();
  let groupLock: string | undefined;
  const release = () => {
    for (const r of g.repos) if (locks.has(r.role)) deps.releaseRunLock(locks.get(r.role)!, r.path, join(r.path, ".orchestrator", "run.lock"));
    if (groupLock) deps.releaseRunLock(groupLock, dir, groupLockFile);
  };
  try {
    groupLock = deps.acquireRunLock("group", dir, groupLockFile);
    for (const r of g.repos) locks.set(r.role, deps.acquireRunLock("group", r.path, join(r.path, ".orchestrator", "run.lock")));
  } catch (e) {
    release();
    throw e;
  }
  return { locks, release };
}

/** Run `fn` under both repos' locks and the group's; children it started are killed and awaited before release. */
async function withGroupLock(g: GroupConfig, dir: string, deps: GroupDeps, fn: (locks: Map<GroupRole, string>) => Promise<void>): Promise<void> {
  const { locks, release } = lockGroup(g, dir, deps);
  process.on("exit", killAll);
  try {
    await fn(locks);
  } finally {
    await settleChildren();
    release();
    process.off("exit", killAll);
  }
}

/** Record a rollback in last-run.json, say how to undo it, and emit group_rollback. */
function finishRollback(g: GroupConfig, deps: GroupDeps, file: string, last: Record<string, unknown>, parked: Partial<Record<GroupRole, string | null>>) {
  deps.writeFileAtomic(file, JSON.stringify({ ...last, rolledBack: true, rolledBackAt: Date.now(), rolledBackParked: parked }, null, 2) + "\n");
  for (const role of ROLES) if (parked[role]) console.log(`to undo: git -C "${memberOf(g, role).path}" reset --hard ${parked[role]}`);
  emit("group_rollback", { group: g.name, parked });
}

/**
 * `orch group rollback NAME`: undo the last passed group goal in both repos. Each repo goes back to the commit the run
 * started on; everything after it (also commits the person made since) is parked on orchestrator/discarded-group-<stamp>.
 * After a failed run whose park failed in a repo, or a run that never finished, it resets each repo whose group
 * checkpoint is still there to that checkpoint instead (parked the same way).
 */
export async function rollbackGroup(g: GroupConfig, deps: GroupDeps): Promise<void> {
  if (process.env.ORCH_GROUP_LOCK) throw new Error("orch group rollback cannot run inside a group run (ORCH_GROUP_LOCK is set)");
  const dir = groupDir(g.name);
  const file = join(dir, "last-run.json");
  type Last = {
    ok?: boolean;
    stamp?: string;
    checkpoints?: Record<string, string>;
    heads?: Record<string, string>;
    kept?: Record<string, string>;
    rolledBack?: boolean;
  };
  let last: Last & Record<string, unknown>;
  try {
    last = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`group "${g.name}" has no last run to roll back`);
  }
  if (last.rolledBack) throw new Error(`the last run of group "${g.name}" is already rolled back`);
  const stamp = last.stamp;
  if (last.ok !== true) {
    // A failed run whose park failed somewhere (`kept`), or one that never finished (killed hard): reset each repo
    // whose group checkpoint is still there to it. A failed run that parked both repos has nothing left to undo.
    const finished = last.ok === false;
    const kept = finished ? ROLES.filter((role) => typeof last.kept?.[role] === "string") : ROLES;
    const nothing = finished
      ? `the last run of group "${g.name}" failed, so there is nothing to roll back: its repos were already reset to where the run started`
      : `the last run of group "${g.name}" did not finish, and no group checkpoint is left in its repos: nothing to roll back`;
    if (!kept.length) throw new Error(nothing);
    if (!finished && (!stamp || !/^[A-Za-z0-9-]+$/.test(stamp))) throw new Error("last-run.json has no valid stamp");
    const targets = kept.map((role) => ({ role, repo: memberOf(g, role), cp: finished ? last.kept![role] : `${GROUP_CHECKPOINT}${stamp}` }));
    for (const r of g.repos) checkMember(r);
    return withGroupLock(g, dir, deps, async (locks) => {
      const found: typeof targets = [];
      for (const x of targets) {
        try {
          if ((await member(x.repo, locks.get(x.role)!, ["has", x.cp])).exists) found.push(x);
        } catch (e) {
          throw new Error(`${x.role}: ${msg(e)}`, { cause: e });
        }
      }
      if (!found.length) throw new Error(nothing);
      const parked: Partial<Record<GroupRole, string | null>> = {};
      for (const x of found) {
        const r = await member(x.repo, locks.get(x.role)!, ["reset", x.cp]);
        parked[x.role] = (r.parked as string | null) ?? null;
        await member(x.repo, locks.get(x.role)!, ["drop", x.cp]);
        console.log(
          `${x.role}: reset to where the group run started; ${parked[x.role] ? `its work and any uncommitted changes parked on ${parked[x.role]}` : "nothing to park"}`,
        );
      }
      finishRollback(g, deps, file, last, parked);
    });
  }
  const sha = /^[0-9a-f]{7,40}$/i;
  const starts = ROLES.map((role) => ({ role, repo: memberOf(g, role), start: last.checkpoints?.[role], end: last.heads?.[role] }));
  for (const x of starts) if (!x.start || !sha.test(x.start)) throw new Error(`last-run.json has no start commit for the ${x.role} repo`);
  if (!stamp || !/^[A-Za-z0-9-]+$/.test(stamp)) throw new Error("last-run.json has no valid stamp");
  for (const r of g.repos) checkMember(r);
  return withGroupLock(g, dir, deps, async (locks) => {
    // Check both repos before resetting either: one refusal leaves both as they are.
    const ahead: Partial<Record<GroupRole, { all: number; own?: number }>> = {};
    for (const x of starts) {
      try {
        const v = await member(x.repo, locks.get(x.role)!, ["verify", x.start!, ...(x.end ? [x.end] : [])]);
        ahead[x.role] = { all: Number(v.ahead), ...(v.after === undefined ? {} : { own: Number(v.after) }) };
      } catch (e) {
        throw new Error(`${x.role}: ${msg(e)}`, { cause: e });
      }
    }
    const parked: Partial<Record<GroupRole, string | null>> = {};
    for (const x of starts) {
      const r = await member(x.repo, locks.get(x.role)!, ["reset", x.start!, stamp]);
      parked[x.role] = (r.parked as string | null) ?? null;
      const n = ahead[x.role]?.all ?? 0;
      console.log(
        `${x.role}: reset to ${x.start!.slice(0, 10)}; ${parked[x.role] ? `${n} commit(s) and any uncommitted changes parked on ${parked[x.role]}` : "nothing to park"}`,
      );
      const own = ahead[x.role]?.own;
      if (own) console.log(`  note: that includes ${own} commit(s) made after the group run, not only the run's own`);
    }
    finishRollback(g, deps, file, last, parked);
  });
}

/** `orch group run NAME "<goal>"`. Throws only before anything is locked; afterwards every path ends with group_end. */
export async function runGroup(g: GroupConfig, goal: string, o: GroupOpts, deps: GroupDeps): Promise<GroupOutcome> {
  if (process.env.ORCH_GROUP_LOCK) throw new Error("orch group run cannot run inside another group run (ORCH_GROUP_LOCK is set)");
  for (const r of g.repos) checkMember(r);
  const serve = groupServe(g);
  const dir = groupDir(g.name);
  const s: Run = { g, goal, o, deps, dir, stamp: stampNow(), locks: new Map(), checkpoints: {}, spent: 0, stopped: false, ending: false, serve };
  // Registered before any lock, so on exit children die before the locks' own exit listeners release them.
  process.on("exit", killAll);
  const groupLockFile = join(dir, "run.lock");
  let groupLock: string | undefined;
  try {
    groupLock = deps.acquireRunLock("group", dir, groupLockFile);
    for (const r of g.repos) s.locks.set(r.role, deps.acquireRunLock("group", r.path, join(r.path, ".orchestrator", "run.lock")));
  } catch (e) {
    for (const r of g.repos) if (s.locks.has(r.role)) deps.releaseRunLock(s.locks.get(r.role)!, r.path, join(r.path, ".orchestrator", "run.lock"));
    if (groupLock) deps.releaseRunLock(groupLock, dir, groupLockFile);
    process.off("exit", killAll);
    throw e;
  }
  rmSync(join(dir, STOP_FILE), { force: true });
  const unwatch = watchStop(s);
  emit("group_start", { group: g.name, goal, repos: g.repos.map((r) => ({ path: r.path, role: r.role })) });
  let outcome: GroupOutcome;
  try {
    outcome = await steps(s);
  } catch (e) {
    await settleChildren();
    const stopped = s.stopped || e instanceof Stopped;
    const limit = !stopped && e instanceof Limit;
    outcome = stopped ? "stopped" : limit ? "limit" : "fail";
    const reason = stopped ? "Stopped" : limit ? "UsageLimit" : msg(e);
    console.error(stopped ? "group run stopped" : limit ? `Stopped: ${msg(e)}` : `group run failed: ${reason}`);
    s.ending = true;
    if (s.checkpoints.backend || s.checkpoints.frontend) await endStep(s, false, stopped || limit ? "interrupted" : "failed", reason);
    else emit("group_end", { ok: false, reason });
  } finally {
    await settleChildren();
    unwatch();
    for (const r of g.repos) deps.releaseRunLock(s.locks.get(r.role)!, r.path, join(r.path, ".orchestrator", "run.lock"));
    deps.releaseRunLock(groupLock!, dir, groupLockFile);
    process.off("exit", killAll);
  }
  return outcome;
}

/** `orch group stop NAME`: ask the running group to stop (it parks both repos as interrupted). */
export function stopGroup(name: string) {
  const dir = groupDir(name);
  if (!existsSync(join(dir, "run.lock"))) throw new Error(`group "${name}" is not running`);
  writeFileSync(join(dir, STOP_FILE), new Date().toISOString());
  console.log(`group "${name}" will stop and park its work`);
}

/** `orch approve --group NAME [--reject WHY | --plan-stdin]`: answer the group plan waiting for approval. */
export function approveGroup(name: string, reject: string | undefined, edited: string | undefined, writeFileAtomic: GroupDeps["writeFileAtomic"]) {
  const dir = groupDir(name);
  const pending = join(dir, PENDING);
  if (!existsSync(pending)) throw new Error(`no group plan is waiting for approval in group "${name}"`);
  const { round } = JSON.parse(readFileSync(pending, "utf8")) as { round: number };
  const d: GroupDecision = { round, action: reject !== undefined ? "reject" : "approve" };
  if (reject !== undefined) d.note = reject.trim().slice(0, 4000);
  else if (edited !== undefined) d.plan = parseGroupPlan(edited);
  writeFileAtomic(join(dir, DECISION), JSON.stringify(d));
  console.log(d.action === "reject" ? "group plan sent back to the coordinator" : `group plan approved${d.plan ? " (edited)" : ""}`);
}
