#!/usr/bin/env tsx
// YAAIORCH (Yet Another AI Orchestrator) CLI. Run from the target repo root. Usage: see USAGE below.
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import { BUILTIN_AGENTS } from "./orch-agents";

const USAGE = `YAAIORCH (Yet Another AI Orchestrator) CLI. Run from the target repo root.
  orch run "<goal>"     one goal, loops architect -> build -> QA until QA passes
  orch add "<goal>"     queue a goal
  orch loop             process the queue continuously (Ctrl+C stops after current goal)
  orch status           show queue
  orch agents           list agents + skills the architect will see
  orch doctor [--json]  check node, claude (installed, logged in), git and the repo
  orch rollback [BRANCH]  reset to the latest (or given) checkpoint; discarded work is kept
                        on an orchestrator/discarded-* branch
  orch prune [--older-than DAYS]  delete orchestrator/* branches older than DAYS (14)
Options: --max-rounds N (5)  --power max|heavy|balanced|economy (heavy)
         --max-cost USD (per goal, no limit by default)  --agent-timeout MINUTES (30)
         --poll SECONDS (15)  --until-empty  --dry-run (plan only; not with loop)
Agents: built-in (architect, fe, be, qa), overridden by ~/.claude/agents and ./.claude/agents.
The architect and verifiers run read-only; implementers may edit.
Checks: after each build phase the orchestrator runs the repo's checks itself and a non-zero exit
fails the round. From .orchestrator/config.json {"checks": {"name": "command"}, "allow": ["Bash(...)"]},
else the package.json scripts typecheck, lint, test, build. Agents may run those commands too.
In a git repo the working tree must be clean. Each round's changes are committed on the current
branch on top of a checkpoint branch (orchestrator/checkpoint-*) that is deleted when QA passes.
A round that changes nothing or repeats the same failures moves one power tier up; two such
rounds in a row stop the goal.
When the Claude usage limit is hit, the goal stops (exit code 3); loop puts it back to pending and
waits until the reset time from the CLI's message.`;

const PHASES = ["foundation", "build", "verify"] as const;
type Phase = (typeof PHASES)[number];
type Task = { agent: string; phase: Phase; task: string; files?: string[]; heavy?: boolean; figma?: string; skills?: string[] };
type Plan = { summary: string; tasks: Task[] };
type Verdict = { passed: boolean; failures: string[] };
/** `note` says why a pending goal is waiting (for example a usage-limit reset). */
type Item = { id: number; goal: string; status: "pending" | "running" | "done" | "failed"; note?: string };
type Entry = { name: string; description: string; builtin?: boolean };
type Result = { agent: string; out: string; touched: string[]; cost: number; error?: string; fatal?: Error };

const POWER = {
  max: { arch: "opus", impl: "opus", heavy: "opus", qa: "opus" },
  heavy: { arch: "opus", impl: "sonnet", heavy: "opus", qa: "opus" },
  balanced: { arch: "sonnet", impl: "sonnet", heavy: "opus", qa: "opus" },
  economy: { arch: "sonnet", impl: "haiku", heavy: "sonnet", qa: "sonnet" },
} as const;
type Power = keyof typeof POWER;
/** Escalation order for stuck rounds. */
const TIERS: Power[] = ["economy", "balanced", "heavy", "max"];

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const DIR = ".orchestrator";
const QUEUE = join(DIR, "queue.json");
const LAST_RUN = join(DIR, "last-run.json");
// Relative, forward slashes, no spaces: safe to pass through the Windows shell.
const BUILTIN_FILE = `${DIR}/builtin-agents.json`;
/** Implementers: allow-list for the check commands, run with acceptEdits. */
const AGENT_SETTINGS = `${DIR}/agent-settings.json`;
/** Architect and verifiers: same allow-list plus a deny on edit tools, run with permission mode "default". */
const READONLY_SETTINGS = `${DIR}/readonly-settings.json`;
const CONFIG_FILE = join(DIR, "config.json");
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
Every foundation and build task must list its files, no file may appear in two tasks, and there must be at least one verify task.`;
const TASK_FORMAT = `

## Reply format
End your reply with exactly one of these lines: "Status: COMPLETE", "Status: PARTIAL" or "Status: FAILED".`;
const VERDICT_FORMAT = `

## Reply format
Do not edit any file. Reply with exactly one JSON object and nothing else:
{"passed": true | false, "failures": ["<what is wrong, where, and how to fix it>"]}
List only problems that need fixing: no notes, no "no defects found". Use an empty failures list when passed is true.
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
type Config = { checks?: Record<string, string>; allow?: string[] };
type Check = { name: string; command: string; ok: boolean; code: number | null; output: string; ms: number };

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch (e) {
    throw new Error(`cannot parse ${path}: ${msg(e)}`);
  }
}

/** Checks from .orchestrator/config.json, else the usual package.json scripts (skipping npm's placeholder test). */
function loadChecks(cfg: Config): Record<string, string> {
  if (cfg.checks) return cfg.checks;
  const scripts = readJsonFile<{ scripts?: Record<string, string> }>("package.json", {}).scripts ?? {};
  return Object.fromEntries(
    CHECK_SCRIPTS.filter((s) => scripts[s] && !/no test specified/.test(scripts[s])).map((s) => [s, `npm run ${s}`]),
  );
}

/**
 * Let agents run the checks and read-only git. Compound commands (cd && ...) still need approval, so
 * they may not. Read-only roles also deny the edit tools and run in permission mode "default", where
 * shell commands that write files are refused too (acceptEdits would let `echo > file` through).
 */
function writeAgentSettings(cfg: Config, checks: Record<string, string>) {
  const cmds = [...Object.values(checks), ...(checks.test ? ["npm test"] : []), "git status", "git diff", "git log", "git show"];
  const allow = [...cmds.flatMap((c) => [`Bash(${c}:*)`, `PowerShell(${c}:*)`]), ...(cfg.allow ?? [])];
  writeFileSync(AGENT_SETTINGS, JSON.stringify({ permissions: { allow } }, null, 2));
  writeFileSync(READONLY_SETTINGS, JSON.stringify({ permissions: { allow, deny: ["Edit", "Write", "MultiEdit", "NotebookEdit"] } }, null, 2));
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
/** Money spent on one goal; `cap` is the --max-cost limit. */
type Budget = { spent: number; cap?: number };
type RunCtx = { budget: Budget; timeoutMs: number };
/** Ends the goal instead of becoming a task failure. */
class BudgetExceeded extends Error {}

/**
 * The Claude subscription's usage limit ("You've hit your 5-hour limit · resets 1:30am (Europe/Bucharest)").
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
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
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

/** "resets 1:30am (Europe/Bucharest)", "resets 14:00" -> epoch ms; undefined if there is no time in the text. */
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

function run(agent: Entry, model: string, prompt: string, ctx: RunCtx, readOnly: boolean): Promise<{ text: string; cost: number }> {
  const { budget } = ctx;
  if (budget.cap !== undefined && budget.spent >= budget.cap)
    return Promise.reject(new BudgetExceeded(`budget of ${usd(budget.cap)} used up (${usd(budget.spent)} spent)`));
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      ...(agent.builtin ? ["--agents", BUILTIN_FILE] : []),
      ...(existsSync(AGENT_SETTINGS) ? ["--settings", readOnly ? READONLY_SETTINGS : AGENT_SETTINGS] : []),
      "--agent", agent.name,
      "--model", model,
      "--output-format", "json",
      "--permission-mode", readOnly ? "default" : "acceptEdits",
      // Checked by the CLI after each turn, so a call can overshoot a little; parallel calls each get the full remainder.
      ...(budget.cap !== undefined ? ["--max-budget-usd", Math.max(0.01, budget.cap - budget.spent).toFixed(2)] : []),
    ];
    const p = spawn(CLAUDE, args, { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32", windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p);
    }, ctx.timeoutMs);
    p.stdout.setEncoding("utf8"); // decode across chunk boundaries
    let out = "";
    p.stdout.on("data", (d: string) => (out += d));
    p.on("error", (e) => (clearTimeout(timer), reject(e)));
    p.on("close", (code) => {
      clearTimeout(timer);
      let r: CliResult | undefined;
      try {
        r = JSON.parse(out);
      } catch {
        /* handled below */
      }
      // Count the cost even when the call failed: the money is spent either way.
      const cost = typeof r?.total_cost_usd === "number" ? r.total_cost_usd : 0;
      budget.spent += cost;
      if (timedOut) {
        const limit = ctx.timeoutMs >= 60_000 ? `${Math.round(ctx.timeoutMs / 60_000)} min` : `${Math.round(ctx.timeoutMs / 1000)} s`;
        return reject(new Error(`${agent.name} timed out after ${limit}`));
      }
      if (r?.subtype === "error_max_budget_usd")
        return reject(new BudgetExceeded(`budget of ${usd(budget.cap ?? 0)} used up (${usd(budget.spent)} spent)`));
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
    const s = c.indexOf("{"), e = c.lastIndexOf("}");
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
  const p = f.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  return process.platform === "win32" ? p.toLowerCase() : p;
};

function validate(plan: Plan, roster: Entry[]) {
  if (!plan || typeof plan.summary !== "string" || !Array.isArray(plan.tasks) || !plan.tasks.length)
    throw new Error('plan must be {"summary": string, "tasks": [...]} with at least one task');
  const names = new Set(roster.map((a) => a.name));
  const owner = new Map<string, string>();
  plan.tasks.forEach((t, i) => {
    if (!t || typeof t.task !== "string" || !t.task.trim()) throw new Error(`task ${i} has no task text`);
    if (!names.has(t.agent)) throw new Error(`task ${i} uses unknown agent "${t.agent}"`);
    if (!(PHASES as readonly string[]).includes(t.phase)) throw new Error(`task ${i} has invalid phase "${t.phase}"`);
    if (t.files !== undefined && !(Array.isArray(t.files) && t.files.every((f) => typeof f === "string")))
      throw new Error(`task ${i}: files must be a list of paths`);
    if (t.phase !== "verify" && !t.files?.length) throw new Error(`${t.phase} task ${i} (${t.agent}) lists no files`);
    for (const f of t.files ?? []) {
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
  return { passed: v.passed, failures };
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
  if (dirty)
    throw new Error(`working tree has uncommitted changes; commit or stash them first, or run "orch rollback" after a stopped run:\n${dirty}`);
  const cp = `${BRANCH_PREFIX}checkpoint-${Date.now()}`;
  git("branch", cp);
  console.log(`checkpoint: ${cp} (roll back with: orch rollback)`);
  emit("checkpoint", { branch: cp });
  return cp;
}

/** Stage everything except .orchestrator and commit it. Returns the short hash, or null if nothing changed. */
function commitAll(message: string): string | null {
  git("add", "-A", "--", ".", NOT_STATE);
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
  git(...identity, "commit", "-q", "-m", message);
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

/** Commit what is left, keep HEAD on a side branch, and reset the current branch to `cp`. */
function moveWorkAside(cp: string, kind: "failed" | "discarded" | "interrupted", message: string): string | null {
  commitAll(message); // throws if it cannot commit: never reset over uncommitted work
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
      git("branch", "-D", cp);
      return;
    }
    if (!park) {
      tryCommit(`orch: ${short(goal)} (unfinished)`);
      console.log(`goal not done; its commits sit on top of ${cp}. Roll back with: orch rollback`);
      return;
    }
    const saved = moveWorkAside(cp, interrupted ? "interrupted" : "failed", `orch: ${short(goal)} (unfinished)`);
    if (saved) console.log(`goal ${interrupted ? "interrupted" : "failed"}; its work is on branch ${saved}, working tree reset to the checkpoint`);
    git("branch", "-D", cp);
  } catch (e) {
    console.warn(`warning: git cleanup failed (checkpoint ${cp} kept): ${msg(e)}`);
  }
}

const checkpoints = () =>
  git("branch", "--list", `${BRANCH_PREFIX}checkpoint-*`, "--format=%(refname:short)").split("\n").filter(Boolean).sort();

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
  // shell on Windows so claude.cmd shims resolve; arguments here are fixed and safe
  return spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", windowsHide: true, timeout: 30_000 });
}

function doctor(): Finding[] {
  const f: Finding[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  f.push({ name: "node", level: major >= 20 ? "ok" : "fail", detail: `v${process.versions.node}${major >= 20 ? "" : " (need 20 or newer)"}` });

  const ver = cli(CLAUDE, ["--version"]);
  const claudeOk = ver.status === 0;
  f.push({ name: "claude", level: claudeOk ? "ok" : "fail", detail: claudeOk ? ver.stdout.trim() : `"${CLAUDE} --version" failed; install Claude Code or set CLAUDE_BIN` });
  if (claudeOk) {
    const auth = cli(CLAUDE, ["auth", "status", "--json"]);
    let loggedIn: boolean | undefined;
    try {
      loggedIn = JSON.parse(auth.stdout).loggedIn;
    } catch {
      /* older CLI or fake: unknown */
    }
    f.push(
      loggedIn === true ? { name: "claude login", level: "ok", detail: "logged in" }
      : loggedIn === false ? { name: "claude login", level: "fail", detail: 'not logged in; run "claude auth login"' }
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
    f.push({ name: "repo", level: dirty ? "fail" : "ok", detail: dirty ? `uncommitted changes (${dirty.split("\n").length}); commit, stash or "orch rollback"` : "clean git repo" });
    if (stale.length) f.push({ name: "checkpoints", level: "warn", detail: `${stale.length} leftover checkpoint(s), latest ${stale.at(-1)}: "orch rollback" or "orch prune"` });
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

type Opts = { maxRounds: number; power: Power; dryRun: boolean; park: boolean; agentTimeoutMs: number; maxCost?: number };

/** Run one build task; trust the diff, not the report. Re-dispatch once on phantom completion. */
async function execute(t: Task, agent: Entry, model: string, ctx: RunCtx): Promise<Result> {
  const prompt =
    `${t.task}\n\nYour files (touch only these):\n${(t.files ?? []).map((f) => `- ${f}`).join("\n")}` +
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
async function makePlan(architect: Entry, workers: Entry[], skills: Entry[], goal: string, failures: string[], note: string, model: string, ctx: RunCtx) {
  const base =
    `Goal: ${goal}\n\nAvailable agents:\n${workers.map((a) => `- ${a.name}: ${a.description}`).join("\n")}\n\n` +
    `Available skills:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(none)"}\n` +
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

/** Failures compared across rounds: case, spacing and numbers (timings, line counts) ignored. */
const failureKey = (fs: string[]) =>
  fs.map((f) => f.toLowerCase().replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim()).sort().join("\n");

type LastRun = { goal: string; status: "running" | "passed" | "failed"; checkpoint?: string; cost: number; state: unknown[] };
const writeLastRun = (lr: LastRun) => (mkdirSync(DIR, { recursive: true }), writeFileSync(LAST_RUN, JSON.stringify(lr, null, 2)));

// ---------- one goal: architect -> foundation -> build (parallel) -> verify, repeat ----------
async function runGoal(goal: string, o: Opts): Promise<boolean> {
  emit("goal_start", { goal, maxRounds: o.maxRounds, dryRun: o.dryRun, power: o.power, maxCost: o.maxCost });
  const ctx: RunCtx = { budget: { spent: 0, cap: o.maxCost }, timeoutMs: o.agentTimeoutMs };
  const lr: LastRun = { goal, status: "running", cost: 0, state: [] };
  let cp = "";
  let passed = false;
  let interrupted = false;
  try {
    cp = o.dryRun ? "" : prepareGit();
    lr.checkpoint = cp || undefined;
    if (!o.dryRun) writeLastRun(lr); // the UI offers rollback from this even if the run is killed in round 1
    passed = await runGoalInner(goal, o, cp, ctx, lr);
    emit("goal_end", { passed, cost: round4(ctx.budget.spent) });
    return passed;
  } catch (e) {
    if (e instanceof UsageLimit) {
      interrupted = true;
      emit("usage_limit", { message: e.message, resetAt: e.resetAt });
    }
    emit("goal_end", {
      passed: false, error: msg(e), cost: round4(ctx.budget.spent),
      ...(e instanceof UsageLimit ? { usageLimit: true, resetAt: e.resetAt } : {}),
    });
    throw e;
  } finally {
    if (cp) finishGit(cp, goal, passed, o.park, interrupted);
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
  const workers = roster.filter((a) => a.name !== "architect");
  const skills = discoverSkills();
  writeBuiltins(roster);
  const cfg = readJsonFile<Config>(CONFIG_FILE, {});
  const checks = loadChecks(cfg);
  writeAgentSettings(cfg, checks);
  console.log(`checks: ${Object.entries(checks).map(([n, c]) => `${n} (${c})`).join(", ") || "none configured"}`);

  let power = o.power;
  let failures: string[] = [];
  let note = "";
  let stuck = 0;

  for (let round = 1; round <= o.maxRounds; round++) {
    const models = POWER[power];
    const spentBefore = ctx.budget.spent;
    console.log(`\n=== round ${round}/${o.maxRounds} (${power}) ===`);
    emit("round_start", { round, power });
    emit("architect_start", { round });
    const { plan, cost: planCost } = await makePlan(architect, workers, skills, goal, failures, note, models.arch, ctx);
    console.log(`plan: ${plan.summary}\n` + plan.tasks.map((t) => `  [${t.phase}] ${t.agent}: ${t.task.slice(0, 70)}`).join("\n"));
    emit("plan", { round, summary: plan.summary, cost: round4(planCost), tasks: plan.tasks.map((t, id) => ({ id, ...t })) });
    if (o.dryRun) return true;

    const idOf = new Map(plan.tasks.map((t, id) => [t, id]));
    const skip = (t: Task) => emit("task_end", { round, id: idOf.get(t)!, agent: t.agent, phase: t.phase, status: "SKIPPED", touched: [] });
    /** Never throws: a failed task becomes a failure for the next round, and its siblings run to the end. */
    const exec = async (t: Task): Promise<Result> => {
      const id = idOf.get(t)!;
      emit("task_start", { round, id, agent: t.agent, phase: t.phase });
      try {
        const r = await execute(t, byName.get(t.agent)!, t.heavy ? models.heavy : models.impl, ctx);
        const status = /Status:\s*(COMPLETE|PARTIAL|FAILED)/i.exec(r.out)?.[1]?.toUpperCase() ?? (r.out.startsWith("PHANTOM") ? "PHANTOM" : "UNKNOWN");
        emit("task_end", { round, id, agent: t.agent, phase: t.phase, status, touched: r.touched, cost: round4(r.cost) });
        return r;
      } catch (e) {
        emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: "ERROR", error: msg(e), touched: [] });
        return { agent: t.agent, out: `ERROR: ${msg(e)}`, touched: [], cost: 0, error: msg(e), fatal: isFatal(e) ? e : undefined };
      }
    };

    const foundation = plan.tasks.filter((t) => t.phase === "foundation");
    const build = plan.tasks.filter((t) => t.phase === "build");
    const verify = plan.tasks.filter((t) => t.phase === "verify");

    const results: Result[] = [];
    for (const t of foundation) {
      if (results.some((r) => r.error)) skip(t);
      else results.push(await exec(t));
    }
    const foundationFailed = results.some((r) => r.error);
    if (foundationFailed) build.forEach(skip);
    else results.push(...(await Promise.all(build.map(exec))));
    for (const r of results) console.log(`[${r.agent}] touched ${r.touched.length} file(s)`);
    const errors = results.filter((r) => r.error).map((r) => `${r.agent} task failed: ${r.error}`);

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
    if (foundationFailed) verify.forEach(skip); // building on a broken foundation is pointless to verify
    else {
      checkResults = runChecks(checks);
      emit("checks", { round, results: checkResults.map(({ name, command, ok, code, ms }) => ({ name, command, ok, code, ms })) });
      const report = results.map((r) => `[${r.agent}] ${r.out}`).join("\n");
      const diff = (cp ? `\n\nChanges since the checkpoint:\n${diffSummary(cp)}` : "") + checkReport(checkResults);
      for (const t of verify) {
        const id = idOf.get(t)!;
        emit("task_start", { round, id, agent: t.agent, phase: t.phase });
        try {
          const r = await run(byName.get(t.agent)!, models.qa, `Goal: ${goal}\n${t.task}\n\nImplementer reports:\n${report}${diff}${VERDICT_FORMAT}`, ctx, true);
          const v = asVerdict(extractJson<Verdict>(r.text));
          emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: v.passed ? "PASS" : "FAIL", failures: v.failures, touched: [], cost: round4(r.cost) });
          verdicts.push(v);
        } catch (e) {
          emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: "ERROR", error: msg(e), touched: [] });
          if (isFatal(e)) throw e;
          verdicts.push({ passed: false, failures: [`${t.agent} could not verify: ${msg(e)}`] });
        }
      }
    }

    // Exit codes beat opinions: a failed check fails the round whatever QA says.
    const checkFailures = checkResults
      .filter((c) => !c.ok)
      .map((c) => `check "${c.name}" failed (\`${c.command}\`, exit ${c.code}):\n${c.output.slice(-800)}`);
    const passed = !errors.length && !checkFailures.length && verdicts.length > 0 && verdicts.every((v) => v.passed);
    const prevKey = failureKey(failures);
    failures = [...errors, ...checkFailures, ...verdicts.flatMap((v) => v.failures)];
    const roundCost = round4(ctx.budget.spent - spentBefore);
    const checkSummary = checkResults.map(({ name, ok, code }) => ({ name, ok, code }));
    lr.state.push({ round, power, plan: plan.summary, touched: results.flatMap((r) => r.touched), checks: checkSummary, passed, failures, cost: roundCost });
    lr.cost = round4(ctx.budget.spent);
    writeLastRun(lr);

    emit("round_end", { round, passed, failures, cost: roundCost });
    if (passed) return console.log("\nQA passed."), true;
    console.log(`QA failed (${failures.length}):\n- ${failures.join("\n- ")}`);

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
      const next = TIERS[TIERS.indexOf(power) + 1];
      emit("stuck", { round, action: next ? "escalate" : "retry", reason: why, power: next ?? power });
      console.warn(`no progress (${why}); ${next ? `moving up to power ${next}` : "already at max power, retrying"}`);
      if (next) power = next;
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
const readQueue = (): Item[] => (existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, "utf8")) : []);
const writeQueue = (q: Item[]) => (mkdirSync(DIR, { recursive: true }), writeFileSync(QUEUE, JSON.stringify(q, null, 2)));

async function loop(o: Opts, pollSec: number, untilEmpty: boolean) {
  if (o.dryRun) throw new Error("--dry-run cannot be used with loop: the goal would stay pending and be planned again forever");
  // Only one orchestrator runs at a time, so anything still "running" was interrupted (crash or Stop).
  const q0 = readQueue();
  const stale = q0.filter((i) => i.status === "running");
  if (stale.length) {
    stale.forEach((i) => (i.status = "pending"));
    writeQueue(q0);
    console.log(`reset interrupted goal(s) to pending: ${stale.map((i) => `#${i.id}`).join(", ")}`);
  }

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.log("\nstopping after current goal...");
  });
  while (!stop) {
    const q = readQueue();
    const item = q.find((i) => i.status === "pending");
    if (!item) {
      if (untilEmpty) break;
      await sleep(pollSec * 1000);
      continue;
    }
    item.status = "running";
    delete item.note;
    writeQueue(q);
    console.log(`\n##### goal #${item.id}: ${item.goal}`);
    emit("queue_item", { id: item.id, goal: item.goal });
    let outcome: "done" | "failed" | "limit" = "failed";
    let resetAt: number | undefined;
    try {
      outcome = (await runGoal(item.goal, o)) ? "done" : "failed";
    } catch (e) {
      if (e instanceof UsageLimit) {
        outcome = "limit";
        resetAt = e.resetAt;
      } else console.error(process.env.ORCH_DEBUG ? e : `Error: ${msg(e)}`);
    }
    // Wait one minute past the reset (the CLI rounds the time); if the reply had no time, retry in 30 min.
    const until = outcome === "limit" ? Number(process.env.ORCH_LIMIT_WAIT_MS) > 0 ? Date.now() + Number(process.env.ORCH_LIMIT_WAIT_MS) : (resetAt ?? Date.now() + 29 * 60_000) + 60_000 : 0;
    const q2 = readQueue(); // re-read: user may have added goals meanwhile
    const cur = q2.find((i) => i.id === item.id);
    if (cur) {
      // A usage limit is not the goal's fault: put it back and try again after the reset.
      cur.status = outcome === "limit" ? "pending" : outcome;
      if (outcome === "limit") cur.note = `usage limit: retrying after ${new Date(until).toLocaleString()}`;
    }
    writeQueue(q2);
    if (outcome === "limit") {
      console.log(`usage limit reached; goal #${item.id} is pending again. Waiting until ${new Date(until).toLocaleString()} (Ctrl+C to stop).`);
      emit("waiting", { reason: "usage_limit", until });
      while (!stop && Date.now() < until) await sleep(Math.min(5000, until - Date.now()));
      const q3 = readQueue();
      const again = q3.find((i) => i.id === item.id);
      if (again?.note) {
        delete again.note;
        writeQueue(q3);
      }
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
  return { maxRounds, power: power as Power, dryRun: !!values["dry-run"], park: false, agentTimeoutMs: timeout * 60_000, maxCost };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "max-rounds": { type: "string", default: "5" },
      power: { type: "string", default: "heavy" },
      "max-cost": { type: "string" },
      "agent-timeout": { type: "string", default: "30" },
      poll: { type: "string", default: "15" },
      "until-empty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "older-than": { type: "string", default: "14" },
    },
  });
  const [cmd, ...rest] = positionals;
  const goal = rest.join(" ");

  switch (cmd) {
    case "run":
      if (!goal) throw new Error('usage: orch run "<goal>"');
      process.exit((await runGoal(goal, parseOpts(values))) ? 0 : 1);
    case "add": {
      if (!goal) throw new Error('usage: orch add "<goal>"');
      const q = readQueue();
      q.push({ id: Math.max(0, ...q.map((i) => i.id)) + 1, goal, status: "pending" });
      writeQueue(q);
      return console.log(`queued #${q.at(-1)!.id}`);
    }
    case "loop": {
      const poll = Number(values.poll);
      if (!(poll > 0)) throw new Error(`--poll must be a positive number of seconds, got "${values.poll}"`);
      return loop({ ...parseOpts(values), park: true }, poll, values["until-empty"]!);
    }
    case "status":
      return console.log(readQueue().map((i) => `#${i.id} [${i.status}] ${i.goal}`).join("\n") || "queue empty");
    case "agents":
      console.log("agents:\n" + discoverAgents().map((a) => `  ${a.name}${a.builtin ? " (built-in)" : ""}: ${a.description}`).join("\n"));
      return console.log("skills:\n" + discoverSkills().map((s) => `  ${s.name}: ${s.description}`).join("\n"));
    case "doctor": {
      const findings = doctor();
      if (values.json) console.log(JSON.stringify(findings));
      else for (const x of findings) console.log(`${x.level === "ok" ? "ok  " : x.level === "warn" ? "warn" : "FAIL"}  ${x.name}: ${x.detail}`);
      process.exit(findings.some((x) => x.level === "fail") ? 1 : 0);
    }
    case "rollback":
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
