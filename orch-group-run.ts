// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

// `orch group run`: one goal across a group's backend and frontend repo. The group process holds the group lock and
// both repos' run locks, checkpoints both repos, asks the coordinator for the contract and one goal per repo, builds
// both repos in parallel (each an `orch run` child under the held lock), and ends by dropping the checkpoints (pass)
// or parking each repo's work and resetting it (fail, usage limit, stop). Bundled into orch.mjs.
//
// It must not import orch.ts (orch.ts imports it): the lock and atomic-write helpers come in as `GroupDeps`. Every
// repo-level git step runs as `orch group-member ...` in that repo, so this file never touches a repo itself.
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { groupSection, groupsDir, memberOf, parseGroupPlan, type GroupConfig, type GroupPlan, type GroupRepo, type GroupRole } from "./orch-group";

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

export const groupDir = (name: string) => join(groupsDir(), name);
const STOP_FILE = "stop";
const PENDING = "plan-pending.json";
const DECISION = "plan-decision.json";

/** How to start this orch again: the same Node.js flags (tsx's loader when run from source) and script. */
export const selfArgs = (): string[] => [...process.execArgv, resolve(process.argv[1] ?? "")];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emit(type: string, data: Record<string, unknown> = {}) {
  if (process.env.ORCH_EVENTS) console.log("@@ORCH@@ " + JSON.stringify({ type, t: Date.now(), ...data }));
}

// ---------- children: every process the group starts, so it can kill or await them all ----------
const live = new Set<{ p: ChildProcess; done: Promise<number> }>();

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
const costArgs = (amount: number | undefined) => (amount === undefined ? [] : ["--max-cost", amount.toFixed(4)]);
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
async function coordinatePlan(s: Run, note?: string): Promise<GroupPlan> {
  const be = repoOf(s, "backend");
  const goal = note ? `${s.goal}\n\nThe person reviewing your previous plan rejected it:\n${note}\nWrite a new contract and goals that answer this.` : s.goal;
  const briefs = Object.fromEntries(ROLES.map((r) => [r, readBrief(repoOf(s, r))]).filter(([, b]) => b));
  const input = JSON.stringify({ goal, briefs });
  let r;
  try {
    r = await member(
      be,
      s.locks.get("backend")!,
      ["coordinate", "plan", "--group", s.g.name, ...modelArgs(s.o), ...costArgs(budgetLeft(s))],
      input,
      "coordinator",
    );
  } catch (e) {
    if (s.stopped) throw new Stopped();
    if ((e as { code?: number }).code === 3) throw new Limit(msg(e));
    throw new Error(`coordinator: ${msg(e)}`, { cause: e });
  }
  const cost = Number(r.cost) || 0;
  s.spent += cost;
  const plan = r.reply as GroupPlan;
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
          if (d.round === round) return d;
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

/** Run `orch run` children in parallel; the first failure stops the others (their work is parked either way). */
async function runChildren(
  s: Run,
  step: "build" | "integration" | "fix",
  round: number,
  goals: Partial<Record<GroupRole, string>>,
  extra: string[],
): Promise<ChildEnd[]> {
  const roles = ROLES.filter((r) => goals[r]);
  const left = budgetLeft(s);
  const started = roles.map((role) => {
    const repo = repoOf(s, role);
    const others = s.g.repos.filter((x) => x.role !== role);
    emit("group_step", { step, repo: role, round });
    let cost = 0;
    const args = [
      "run",
      goals[role]!,
      "--group-context",
      join(s.dir, `context-${role}.md`),
      ...others.flatMap((x) => ["--read-dir", x.path]),
      "--strict-files",
      "--no-commands",
      ...modelArgs(s.o),
      ...costArgs(left === undefined ? undefined : left / 2),
      ...(s.o.maxRounds ? ["--max-rounds", String(s.o.maxRounds)] : []),
      ...extra,
    ];
    const c = runChild(repo, args, { ORCH_GROUP_LOCK: s.locks.get(role)! }, (event) => {
      if (event.type === "goal_end" && typeof event.cost === "number") cost = event.cost;
      emit("group_child", { repo: repo.path, role, event });
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
 * Step 4 (Task 7): integration of the built repos against the running backend, with coordinator fault calls and
 * fix rounds. Until it lands, a passed build is the group's pass.
 */
async function integrationStep(s: Run): Promise<"pass" | "fail" | "limit"> {
  const serve = repoOf(s, "backend").serve;
  console.warn(
    serve
      ? "warning: integration against the running backend is not available yet: integration skipped"
      : "warning: no serve configured for the backend repo: integration skipped",
  );
  return "pass";
}

/**
 * Pass: drop both checkpoints. Otherwise park each repo's work on orchestrator/<kind>-group-<stamp>, reset to the
 * checkpoint and drop it (the repo is back where it started); a checkpoint whose park failed is kept.
 */
async function endStep(s: Run, ok: boolean, kind: "failed" | "interrupted", reason?: string): Promise<void> {
  const parked: Partial<Record<GroupRole, string | null>> = {};
  for (const role of ROLES) {
    const cp = s.checkpoints[role];
    if (!cp) continue;
    const repo = repoOf(s, role);
    try {
      if (ok) await member(repo, s.locks.get(role)!, ["drop", cp.branch]);
      else {
        const r = await member(repo, s.locks.get(role)!, ["park", cp.branch, kind]);
        parked[role] = (r.parked as string | null) ?? null;
        await member(repo, s.locks.get(role)!, ["drop", cp.branch]);
        console.log(`${role}: ${parked[role] ? `work parked on ${parked[role]}` : "nothing to park"}; reset to ${cp.branch.replace(/^.*\//, "")}`);
      }
    } catch (e) {
      if (!ok) parked[role] = null;
      console.warn(`warning: ${role}: could not ${ok ? "drop" : "park"} (${cp.branch} kept): ${msg(e)}`);
    }
  }
  writeLast(s, { ok, ...(reason ? { reason } : {}), ...(ok ? {} : { parked }), ended: Date.now() });
  emit("group_end", { ok, ...(reason ? { reason } : {}), ...(ok ? {} : { parked }) });
}

async function steps(s: Run): Promise<GroupOutcome> {
  await checkpointAll(s);
  writeLast(s, { started: Date.now() });
  const plan = await planStep(s);
  s.plan = plan;
  for (const role of ROLES) if (!plan.goals[role]) console.log(`${role}: nothing to build for this goal`);
  const ends = await runChildren(s, "build", 1, plan.goals, s.o.fast === true ? ["--fast"] : s.o.fast === false ? ["--no-fast"] : []);
  if (s.stopped) throw new Stopped();
  if (ends.some((e) => e.code === 3)) throw new Limit("a member run hit the Claude usage limit");
  const failed = ends.filter((e) => e.code !== 0 && !e.stopped);
  if (failed.length) throw new Error(`build failed in ${failed.map((e) => e.role).join(" and ")}`);
  const integration = await integrationStep(s);
  if (integration === "limit") throw new Limit("a member run hit the Claude usage limit");
  if (integration === "fail") throw new Error("integration failed");
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

/** `orch group run NAME "<goal>"`. Throws only before anything is locked; afterwards every path ends with group_end. */
export async function runGroup(g: GroupConfig, goal: string, o: GroupOpts, deps: GroupDeps): Promise<GroupOutcome> {
  if (process.env.ORCH_GROUP_LOCK) throw new Error("orch group run cannot run inside another group run (ORCH_GROUP_LOCK is set)");
  for (const r of g.repos) checkMember(r);
  const dir = groupDir(g.name);
  const s: Run = { g, goal, o, deps, dir, stamp: stampNow(), locks: new Map(), checkpoints: {}, spent: 0, stopped: false };
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
