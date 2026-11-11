#!/usr/bin/env tsx
// Orchestrator CLI. Run from the target repo root. Usage: see USAGE below.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import { BUILTIN_AGENTS } from "./orch-agents";

const USAGE = `Orchestrator CLI. Run from the target repo root.
  orch run "<goal>"     one goal, loops architect -> build -> QA until QA passes
  orch add "<goal>"     queue a goal
  orch loop             process the queue continuously (Ctrl+C stops after current goal)
  orch status           show queue
  orch agents           list agents + skills the architect will see
Options: --max-rounds N (5)  --power max|heavy|balanced|economy (heavy)
         --poll SECONDS (15)  --until-empty  --dry-run (plan only; not with loop)
Agents: built-in (architect, fe, be, qa), overridden by ~/.claude/agents and ./.claude/agents.
Checks: after each build phase the orchestrator runs the repo's checks itself and a non-zero exit
fails the round. From .orchestrator/config.json {"checks": {"name": "command"}, "allow": ["Bash(...)"]},
else the package.json scripts typecheck, lint, test, build. Agents may run those commands too.
In a git repo the working tree must be clean. Each round's changes are committed on the current
branch on top of a checkpoint branch (orchestrator/checkpoint-*) that is deleted when QA passes.`;

const PHASES = ["foundation", "build", "verify"] as const;
type Phase = (typeof PHASES)[number];
type Task = { agent: string; phase: Phase; task: string; files?: string[]; heavy?: boolean; figma?: string; skills?: string[] };
type Plan = { summary: string; tasks: Task[] };
type Verdict = { passed: boolean; failures: string[] };
type Item = { id: number; goal: string; status: "pending" | "running" | "done" | "failed" };
type Entry = { name: string; description: string; builtin?: boolean };
type Result = { agent: string; out: string; touched: string[]; error?: string };

const POWER = {
  max: { arch: "opus", impl: "opus", heavy: "opus", qa: "opus" },
  heavy: { arch: "opus", impl: "sonnet", heavy: "opus", qa: "opus" },
  balanced: { arch: "sonnet", impl: "sonnet", heavy: "opus", qa: "opus" },
  economy: { arch: "sonnet", impl: "haiku", heavy: "sonnet", qa: "sonnet" },
} as const;

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const DIR = ".orchestrator";
const QUEUE = join(DIR, "queue.json");
/** Relative, forward slashes, no spaces: safe to pass through the Windows shell. */
const BUILTIN_FILE = `${DIR}/builtin-agents.json`;
/** Permission allow-list for agents, passed with `claude --settings`. */
const SETTINGS_FILE = `${DIR}/agent-settings.json`;
const CONFIG_FILE = join(DIR, "config.json");
const CHECK_SCRIPTS = ["typecheck", "lint", "test", "build"];
const CHECK_TIMEOUT_MS = 10 * 60_000;
/** Pathspec that keeps the orchestrator's own state out of status, diffs and commits. */
const NOT_STATE = ":(exclude).orchestrator";

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

/** Let agents run the checks and read-only git. Compound commands (cd && ...) still need approval, so they may not. */
function writeAgentSettings(cfg: Config, checks: Record<string, string>) {
  const cmds = [...Object.values(checks), ...(checks.test ? ["npm test"] : []), "git status", "git diff", "git log", "git show"];
  const allow = [...cmds.flatMap((c) => [`Bash(${c}:*)`, `PowerShell(${c}:*)`]), ...(cfg.allow ?? [])];
  writeFileSync(SETTINGS_FILE, JSON.stringify({ permissions: { allow } }, null, 2));
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
type CliResult = { result?: unknown; is_error?: boolean; subtype?: string };

function run(agent: Entry, model: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      ...(agent.builtin ? ["--agents", BUILTIN_FILE] : []),
      ...(existsSync(SETTINGS_FILE) ? ["--settings", SETTINGS_FILE] : []),
      "--agent", agent.name,
      "--model", model,
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
    ];
    const p = spawn(CLAUDE, args, { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32", windowsHide: true });
    p.stdout.setEncoding("utf8"); // decode across chunk boundaries
    let out = "";
    p.stdout.on("data", (d: string) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${agent.name} exited ${code}`));
      let r: CliResult;
      try {
        r = JSON.parse(out);
      } catch {
        return reject(new Error(`${agent.name}: unparsable CLI output: ${out.slice(0, 200)}`));
      }
      if (r.is_error || typeof r.result !== "string") {
        const detail = typeof r.result === "string" ? `: ${r.result.slice(0, 200)}` : "";
        return reject(new Error(`${agent.name}: CLI returned ${r.subtype ?? "an error"}${detail}`));
      }
      resolve(r.result);
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

// ---------- git: checkpoint, commit per round, park failed work ----------
function isGitRepo() {
  try {
    return git("rev-parse", "--is-inside-work-tree") === "true";
  } catch {
    return false;
  }
}

/** Refuse a dirty tree, then create the rollback branch. Returns "" outside git. */
function prepareGit(): string {
  if (!isGitRepo()) {
    console.warn("warning: not a git repo; no checkpoint, no commits, no diff checks");
    return "";
  }
  try {
    git("rev-parse", "--verify", "HEAD");
  } catch {
    throw new Error("the git repo has no commits yet; make an initial commit first");
  }
  const dirty = git("status", "--porcelain", "--", ".", NOT_STATE);
  if (dirty) throw new Error(`working tree has uncommitted changes; commit or stash them first:\n${dirty}`);
  const cp = `orchestrator/checkpoint-${Date.now()}`;
  git("branch", cp);
  console.log(`checkpoint: ${cp} (roll back with: git reset --hard ${cp})`);
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

function tryCommit(message: string) {
  try {
    const c = commitAll(message);
    if (c) console.log(`committed ${c}: ${message}`);
  } catch (e) {
    console.warn(`warning: commit failed, continuing without it: ${msg(e)}`);
  }
}

/** Diff stat against the checkpoint, plus files that are new and not committed yet. */
function diffSummary(cp: string) {
  const stat = git("diff", "--stat", cp, "--", ".", NOT_STATE);
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", ".", NOT_STATE);
  return (stat || "(no changes)") + (untracked ? `\nNew files not committed:\n${untracked}` : "");
}

/**
 * After a goal: on pass, drop the checkpoint. On failure in loop mode, move the goal's commits to
 * orchestrator/failed-* and reset to the checkpoint, so the next goal starts from a clean base.
 */
function finishGit(cp: string, goal: string, passed: boolean, park: boolean) {
  try {
    tryCommit(`orch: ${short(goal)} (unfinished)`);
    if (passed) {
      git("branch", "-D", cp);
      return;
    }
    if (!park) {
      console.log(`goal not done; its commits sit on top of ${cp}. Roll back with: git reset --hard ${cp}`);
      return;
    }
    if (git("status", "--porcelain", "--", ".", NOT_STATE)) {
      console.warn(`warning: could not commit the failed goal's changes; leaving the tree as is (checkpoint ${cp})`);
      return;
    }
    if (git("rev-parse", "HEAD") !== git("rev-parse", cp)) {
      const saved = cp.replace("checkpoint", "failed");
      git("branch", saved);
      git("reset", "-q", "--hard", cp);
      console.log(`goal failed; its work is on branch ${saved}, working tree reset to the checkpoint`);
    }
    git("branch", "-D", cp);
  } catch (e) {
    console.warn(`warning: git cleanup failed: ${msg(e)}`);
  }
}

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);

type Opts = { maxRounds: number; models: (typeof POWER)[keyof typeof POWER]; dryRun: boolean; park: boolean };

/** Run one build task; trust the diff, not the report. Re-dispatch once on phantom completion. */
async function execute(t: Task, agent: Entry, o: Opts): Promise<Result> {
  const prompt =
    `${t.task}\n\nYour files (touch only these):\n${(t.files ?? []).map((f) => `- ${f}`).join("\n")}` +
    (t.figma ? `\n\nFigma: ${t.figma}` : "") +
    (t.skills?.length ? `\n\nBefore starting, load these skills with the Skill tool: ${t.skills.join(", ")}` : "") +
    TASK_FORMAT;
  const model = t.heavy ? o.models.heavy : o.models.impl;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = new Map((t.files ?? []).map((f) => [f, sig(f)]));
    const out = await run(agent, model, prompt);
    const touched = (t.files ?? []).filter((f) => sig(f) !== before.get(f));
    if (!t.files?.length || touched.length || !/Status:\s*COMPLETE/i.test(out)) return { agent: t.agent, out, touched };
    console.warn(`phantom completion by ${t.agent}; re-dispatching`);
  }
  return { agent: t.agent, out: "PHANTOM: no diff after 2 attempts", touched: [] };
}

/** Ask the architect for a plan; on bad JSON or a rejected plan, ask once more with the reason. */
async function makePlan(architect: Entry, workers: Entry[], skills: Entry[], goal: string, failures: string[], o: Opts): Promise<Plan> {
  const base =
    `Goal: ${goal}\n\nAvailable agents:\n${workers.map((a) => `- ${a.name}: ${a.description}`).join("\n")}\n\n` +
    `Available skills:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(none)"}\n` +
    (failures.length ? `\nPrevious QA failures to fix:\n- ${failures.join("\n- ")}\n` : "") +
    "\nProduce the plan." +
    PLAN_FORMAT;
  let prompt = base;
  for (let attempt = 1; ; attempt++) {
    const reply = await run(architect, o.models.arch, prompt);
    try {
      const plan = extractJson<Plan>(reply);
      validate(plan, workers);
      return plan;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.warn(`plan rejected (${msg(e)}); asking the architect again`);
      prompt = `${base}\n\nYour previous reply was rejected: ${msg(e)}\nFix that and reply with the JSON plan only.`;
    }
  }
}

// ---------- one goal: architect -> foundation -> build (parallel) -> verify, repeat ----------
async function runGoal(goal: string, o: Opts): Promise<boolean> {
  emit("goal_start", { goal, maxRounds: o.maxRounds, dryRun: o.dryRun });
  let cp = "";
  let passed = false;
  try {
    cp = o.dryRun ? "" : prepareGit();
    passed = await runGoalInner(goal, o, cp);
    emit("goal_end", { passed });
    return passed;
  } catch (e) {
    emit("goal_end", { passed: false, error: msg(e) });
    throw e;
  } finally {
    if (cp) finishGit(cp, goal, passed, o.park);
  }
}

async function runGoalInner(goal: string, o: Opts, cp: string): Promise<boolean> {
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

  let failures: string[] = [];
  const state: unknown[] = [];

  for (let round = 1; round <= o.maxRounds; round++) {
    console.log(`\n=== round ${round}/${o.maxRounds} ===`);
    emit("round_start", { round });
    emit("architect_start", { round });
    const plan = await makePlan(architect, workers, skills, goal, failures, o);
    console.log(`plan: ${plan.summary}\n` + plan.tasks.map((t) => `  [${t.phase}] ${t.agent}: ${t.task.slice(0, 70)}`).join("\n"));
    emit("plan", { round, summary: plan.summary, tasks: plan.tasks.map((t, id) => ({ id, ...t })) });
    if (o.dryRun) return true;

    const idOf = new Map(plan.tasks.map((t, id) => [t, id]));
    const skip = (t: Task) => emit("task_end", { round, id: idOf.get(t)!, agent: t.agent, phase: t.phase, status: "SKIPPED", touched: [] });
    /** Never throws: a failed task becomes a failure for the next round, and its siblings run to the end. */
    const exec = async (t: Task): Promise<Result> => {
      const id = idOf.get(t)!;
      emit("task_start", { round, id, agent: t.agent, phase: t.phase });
      try {
        const r = await execute(t, byName.get(t.agent)!, o);
        const status = /Status:\s*(COMPLETE|PARTIAL|FAILED)/i.exec(r.out)?.[1]?.toUpperCase() ?? (r.out.startsWith("PHANTOM") ? "PHANTOM" : "UNKNOWN");
        emit("task_end", { round, id, agent: t.agent, phase: t.phase, status, touched: r.touched });
        return r;
      } catch (e) {
        emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: "ERROR", error: msg(e), touched: [] });
        return { agent: t.agent, out: `ERROR: ${msg(e)}`, touched: [], error: msg(e) };
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

    if (cp) tryCommit(`orch: ${short(goal)} (round ${round})`);

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
          const reply = await run(byName.get(t.agent)!, o.models.qa, `Goal: ${goal}\n${t.task}\n\nImplementer reports:\n${report}${diff}${VERDICT_FORMAT}`);
          const v = asVerdict(extractJson<Verdict>(reply));
          emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: v.passed ? "PASS" : "FAIL", failures: v.failures, touched: [] });
          verdicts.push(v);
        } catch (e) {
          emit("task_end", { round, id, agent: t.agent, phase: t.phase, status: "ERROR", error: msg(e), touched: [] });
          verdicts.push({ passed: false, failures: [`${t.agent} could not verify: ${msg(e)}`] });
        }
      }
    }

    // Exit codes beat opinions: a failed check fails the round whatever QA says.
    const checkFailures = checkResults
      .filter((c) => !c.ok)
      .map((c) => `check "${c.name}" failed (\`${c.command}\`, exit ${c.code}):\n${c.output.slice(-800)}`);
    const passed = !errors.length && !checkFailures.length && verdicts.length > 0 && verdicts.every((v) => v.passed);
    failures = [...errors, ...checkFailures, ...verdicts.flatMap((v) => v.failures)];
    const checkSummary = checkResults.map(({ name, ok, code }) => ({ name, ok, code }));
    state.push({ round, plan: plan.summary, touched: results.flatMap((r) => r.touched), checks: checkSummary, passed, failures });
    writeFileSync(join(DIR, "last-run.json"), JSON.stringify({ goal, state }, null, 2));

    emit("round_end", { round, passed, failures });
    if (passed) return console.log("\nQA passed."), true;
    console.log(`QA failed (${failures.length}):\n- ${failures.join("\n- ")}`);
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
    writeQueue(q);
    console.log(`\n##### goal #${item.id}: ${item.goal}`);
    emit("queue_item", { id: item.id, goal: item.goal });
    const ok = await runGoal(item.goal, o).catch((e) => (console.error(e), false));
    const q2 = readQueue(); // re-read: user may have added goals meanwhile
    const cur = q2.find((i) => i.id === item.id);
    if (cur) cur.status = ok ? "done" : "failed";
    writeQueue(q2);
  }
}

function parseOpts(values: Record<string, string | boolean | undefined>): Opts {
  const maxRounds = Number(values["max-rounds"]);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error(`--max-rounds must be a whole number of at least 1, got "${values["max-rounds"]}"`);
  const power = String(values.power);
  if (!Object.hasOwn(POWER, power)) throw new Error(`--power must be one of ${Object.keys(POWER).join(", ")}, got "${power}"`);
  return { maxRounds, models: POWER[power as keyof typeof POWER], dryRun: !!values["dry-run"], park: false };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "max-rounds": { type: "string", default: "5" },
      power: { type: "string", default: "heavy" },
      poll: { type: "string", default: "15" },
      "until-empty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
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
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
