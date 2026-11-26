// YAAIORCH eval runner. Node 22.18+ / 23.6+ runs this file directly (type stripping).
//
//   node evals/run.ts --reference                 check the suite itself: hidden tests fail on the
//                                                 untouched fixture and pass with the reference solution
//   node evals/run.ts [options]                   run orch on every case x power tier, grade with hidden tests
//
// Head-to-head with a single agent (the control group):
//   node evals/run.ts --power economy,heavy --single sonnet,opus
// runs each case once per orch tier and once as a single `claude -p` call per model, graded the same way.
//
// Options:
//   --cases a,b          case ids (default: all)          --power economy,heavy  orch tiers (default: economy; "none" for no orch runs;
//                                                                              suffixes: +fast (--fast), +nomem (--no-brief --no-notes),
//                                                                              +critic (--critic), +noresume (--no-resume),
//                                                                              +diffcritic (--diff-critic), +review (--review), +novisual
//                                                                              (--no-visual), e.g. economy+nomem)
//   --single m1,m2       also run a single agent with these models (control group), e.g. sonnet,opus
//   --orch-model SPEC    passed to orch as --model for every orch run, e.g. "architect=opus,impl=haiku"
//   --repeat N           runs per case and tier (1)       --parallel N           runs at once (1)
//   --max-rounds N       passed to orch (4)               --max-cost USD         per run, passed to orch (3)
//   --agent-timeout MIN  passed to orch (15)              --eval-timeout MIN     kill a whole run after (30)
//   --claude-bin PATH    use another claude (a fake, to test the runner without spending tokens)
//   --orch PATH          run this orch.mjs instead of ../orch.ts through tsx
//   --wait-on-limit      on a Claude usage limit, pause until the reset and carry on (default: stop)
//   --usage-cap 5h=60    treat the subscription's usage at this percentage like the limit (also week=N), so the
//                        eval leaves the rest of the window for you; passed to orch, and checked before each run
//   --resume STAMP       finish results/STAMP.jsonl: skip runs already recorded, drop ones a usage limit spoiled
//
// A run cut short by the usage limit (orch exit code 3) is never recorded as a failure.
//
// Each run copies a fixture into a fresh git repo under the OS temp dir, runs `orch run "<goal>"` there
// (a series case runs each of its goals in turn on the same repo, so the project brief and notes carry over),
// then copies the case's hidden tests in (agents never see them) and runs the case's grade command.
// Results: evals/results/<stamp>.jsonl (one line per run) and <stamp>.md (summary). Work dirs are kept.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveClaude } from "../claude-bin.ts";

/**
 * `goals`: a series, run one after another on the same repo and graded once at the end. `gate`: a gate check command
 * (orch's `gateChecks`, which agents cannot run); `{gate}` in it and in `grade` stands for the case's gate suite,
 * `evals/gate/<id>/`, kept outside the repo.
 */
type Role = "backend" | "frontend";
/**
 * `group`: a repo-group case, run with `orch group run` across a backend and a frontend fixture. `group.serve` starts the
 * backend for the integration step (`{port}` is the run's own port) and `group.health` is the path that answers when it
 * is up. Its `grade` has a command per repo; the frontend's runs with EVAL_BACKEND set to the run's backend repo, so its
 * hidden tests can drive the web client against the backend the same run built.
 */
type GroupSpec = Record<Role, string> & { serve: string; health: string };
type Case = {
  id: string;
  fixture?: string;
  group?: GroupSpec;
  kind: string;
  difficulty: string;
  goal?: string;
  goals?: string[];
  grade: string | Record<Role, string>;
  gate?: string;
};
const goalsOf = (c: Case): string[] => c.goals ?? [c.goal!];
const ROLES: Role[] = ["backend", "frontend"];
/** `power` is the configuration label: an orch tier ("economy"), or "single:<model>" for the control group. */
type Run = {
  case: string;
  kind: string;
  difficulty: string;
  power: string;
  rep: number;
  runner?: "orch" | "single";
  claimed: boolean;
  hidden: boolean;
  rounds: number;
  cost: number;
  seconds: number;
  goals?: number;
  stuck: number;
  /** Group cases: integration fix calls (the coordinator blamed a side after a failed integration check). */
  faults?: number;
  finalPower?: string;
  error?: string;
  exit: number | null;
  timedOut: boolean;
  dir: string;
  gradeTail: string;
};

const EVALS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(EVALS);
const TIERS = ["economy", "balanced", "heavy", "max"];

const { values: a } = parseArgs({
  options: {
    reference: { type: "boolean", default: false },
    cases: { type: "string" },
    power: { type: "string", default: "economy" },
    single: { type: "string" },
    "orch-model": { type: "string" },
    repeat: { type: "string", default: "1" },
    parallel: { type: "string", default: "1" },
    "max-rounds": { type: "string", default: "4" },
    "max-cost": { type: "string", default: "3" },
    "agent-timeout": { type: "string", default: "15" },
    "eval-timeout": { type: "string", default: "30" },
    "claude-bin": { type: "string" },
    "user-plugins": { type: "boolean", default: false },
    orch: { type: "string" },
    "wait-on-limit": { type: "boolean", default: false },
    "usage-cap": { type: "string" },
    resume: { type: "string" },
  },
});
// orch runs inside each run's work dir, so a relative --claude-bin path would not be found there.
if (a["claude-bin"] && /[\\/]/.test(a["claude-bin"])) a["claude-bin"] = resolve(a["claude-bin"]);
const CAP_SPEC = /^(?:5h|week)=\d{1,3}(?:,(?:5h|week)=\d{1,3})?$/;
if (a["usage-cap"] !== undefined && !CAP_SPEC.test(a["usage-cap"])) fail(`--usage-cap must look like 5h=60 or 5h=60,week=80, got "${a["usage-cap"]}"`);
/** --usage-cap per window, as orch's usage events name them. */
const caps: Partial<Record<"fiveHour" | "week", number>> = Object.fromEntries(
  (a["usage-cap"] ?? "")
    .split(",")
    .filter(Boolean)
    .map((p) => p.split("="))
    .map(([w, n]) => [w === "5h" ? "fiveHour" : "week", Number(n)]),
);
/** The newest reading any finished run reported (orch's `usage` events). */
const usageNow: Partial<Record<"fiveHour" | "week", { pct: number; resetsAt: number }>> = {};
function noteUsage(events: any[]) {
  for (const e of events)
    if (e.type === "usage")
      for (const w of ["fiveHour", "week"] as const) if (typeof e[w]?.pct === "number" && typeof e[w]?.resetsAt === "number") usageNow[w] = e[w];
}
/** A window at or over its cap and not reset yet: when it resets. Orch only learns the usage from its own first call. */
function capReached(): { what: string; resetAt: number } | null {
  for (const w of ["fiveHour", "week"] as const) {
    const r = usageNow[w];
    const cap = caps[w];
    if (cap !== undefined && r && r.pct >= cap && r.resetsAt > Date.now())
      return { what: `${w === "fiveHour" ? "5-hour" : "weekly"} usage at ${r.pct}% (cap ${cap}%)`, resetAt: r.resetsAt };
  }
  return null;
}

/** Same wording orch.ts matches; also catches records an older orch wrote as plain failures. */
const LIMIT_RE = /\b(?:hit|reached) your [^\n.]{0,40}?limit\b/i;

const allCases: Case[] = JSON.parse(readFileSync(join(EVALS, "cases.json"), "utf8"));
const wanted = a.cases
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const unknown = wanted?.filter((id) => !allCases.some((c) => c.id === id)) ?? [];
if (unknown.length) fail(`unknown case(s): ${unknown.join(", ")}. Known: ${allCases.map((c) => c.id).join(", ")}`);
const cases = wanted ? allCases.filter((c) => wanted.includes(c.id)) : allCases;
const powers =
  a.power === "none"
    ? []
    : a
        .power!.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
// Suffixes add orch options: "economy+fast" (direct attempt first), "economy+nomem" (no project brief or notes,
// to measure what they are worth), "economy+critic" (plan critic), "economy+noresume" (fix rounds start cold). They combine: "heavy+nomem+critic".
const SUFFIXES: Record<string, string[]> = {
  fast: ["--fast"],
  nomem: ["--no-brief", "--no-notes"],
  critic: ["--critic"],
  noresume: ["--no-resume"],
  diffcritic: ["--diff-critic"],
  review: ["--review"],
  novisual: ["--no-visual"],
};
const tierOf = (label: string) => label.split("+")[0];
// orch starts with a direct attempt by default; a tier without "+fast" keeps meaning the full loop, so its results
// compare with earlier ones.
const suffixArgs = (label: string) => {
  const parts = label.split("+").slice(1);
  return [...(parts.includes("fast") ? [] : ["--no-fast"]), ...parts.flatMap((x) => SUFFIXES[x] ?? [])];
};
for (const p of powers) {
  const bad = p
    .split("+")
    .slice(1)
    .filter((x) => !SUFFIXES[x]);
  if (!TIERS.includes(tierOf(p)) || bad.length)
    fail(
      `unknown power "${p}"; use ${TIERS.join(", ")} with optional ${Object.keys(SUFFIXES)
        .map((x) => `+${x}`)
        .join(", ")}, or none`,
    );
}
for (const c of allCases) {
  if (!c.goal && !c.goals?.length) fail(`case ${c.id} has neither goal nor goals`);
  if (
    c.group &&
    (c.goals || c.gate || typeof c.grade !== "object" || !ROLES.every((r) => c.group![r] && typeof (c.grade as Record<Role, string>)[r] === "string"))
  )
    fail(`group case ${c.id} needs one goal, no gate, and group and grade entries for backend and frontend`);
  if (!c.group && (!c.fixture || typeof c.grade !== "string")) fail(`case ${c.id} needs a fixture and a grade command`);
}
// orch group run takes the tier and --fast/--no-fast only: the other suffixes are options of orch run.
const groupPowers = powers.filter((p) =>
  p
    .split("+")
    .slice(1)
    .some((x) => x !== "fast"),
);
if (cases.some((c) => c.group) && groupPowers.length) fail(`group cases take a tier with optional +fast only, not ${groupPowers.join(", ")}`);
const singles = (a.single ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const m of singles) if (!/^[\w.:-]+$/.test(m)) fail(`bad model name "${m}"`);
/** Configuration labels, in table order: orch tiers, then the single-agent control group. */
const configs = [...powers, ...singles.map((m) => `single:${m}`)];
if (!configs.length) fail("nothing to run: give --power and/or --single");

const stamp = a.resume ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const workRoot = join(tmpdir(), "yaaiorch-evals", stamp);

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

/** Fresh git repo with the fixture committed, plus any overlay directories copied on top. */
function setupRepo(dir: string, c: Case, overlays: string[] = [], fixture = c.fixture!) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(EVALS, "fixtures", fixture), dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  servePort(dir);
  if (c.gate) gateSetup(dir, c);
  git("init", "-q", "-b", "main");
  git("-c", "user.name=evals", "-c", "user.email=evals@localhost", "add", "-A");
  git("-c", "user.name=evals", "-c", "user.email=evals@localhost", "commit", "-q", "-m", `fixture ${fixture}`);
  // Commits made by orch use the repo's identity; give the throwaway repo one.
  git("config", "user.name", "evals");
  git("config", "user.email", "evals@localhost");
  for (const o of overlays) cpSync(o, dir, { recursive: true });
}

/** A group case's repos and the YAAIORCH_HOME that holds its group config ("eval"), all inside `dir`. */
const groupDirs = (dir: string) => ({ backend: join(dir, "backend"), frontend: join(dir, "frontend"), home: join(dir, "home") });

/**
 * A group case: both fixtures as fresh repos (with `<overlay>/backend` and `<overlay>/frontend` on top, for
 * --reference) and the group config, whose backend serve gets a port of its own so parallel runs never meet.
 */
function setupGroup(dir: string, c: Case, overlay?: string) {
  const d = groupDirs(dir);
  for (const role of ROLES) setupRepo(d[role], c, overlay ? [join(overlay, role)] : [], c.group![role]);
  const port = nextPort++;
  mkdirSync(join(d.home, "groups"), { recursive: true });
  const repos = [
    {
      path: d.backend,
      role: "backend",
      serve: { command: c.group!.serve.replaceAll("{port}", String(port)), url: `http://127.0.0.1:${port}${c.group!.health}`, timeout: 60 },
    },
    { path: d.frontend, role: "frontend", env: { API_URL: "{backend}" } },
  ];
  writeFileSync(join(d.home, "groups", "eval.json"), JSON.stringify({ name: "eval", repos }, null, 2));
  // orch group run has no plugin flags: the member runs and the coordinator read them from each repo's config
  // (git-ignored, so it is no change to commit).
  if (!a["user-plugins"])
    for (const role of ROLES) {
      const file = join(d[role], ".orchestrator", "config.json");
      mkdirSync(dirname(file), { recursive: true });
      const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      writeFileSync(file, JSON.stringify({ ...cfg, plugins: { off: true, hooks: false } }, null, 2));
    }
}

/**
 * Browser checks (config "serve"): each run's app gets a port of its own, so parallel runs never check each
 * other's dev server. The fixture's port is replaced in both the url and the command.
 */
let nextPort = 20_000 + Math.floor(Math.random() * 20_000);
function servePort(dir: string) {
  const file = join(dir, ".orchestrator", "config.json");
  if (!existsSync(file)) return;
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  const old = cfg.serve?.url && new URL(cfg.serve.url).port;
  if (!old) return;
  const port = String(nextPort++);
  cfg.serve.url = cfg.serve.url.replace(`:${old}`, `:${port}`);
  if (cfg.serve.command) cfg.serve.command = cfg.serve.command.replaceAll(old, port);
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}

/** Forward slashes: `{gate}` paths go into shell commands on every OS. */
const slashes = (p: string) => p.replace(/\\/g, "/");
/** The case's pristine gate suite. */
const gateSource = (c: Case) => slashes(join(EVALS, "gate", c.id));
/** The run's copy of the gate suite: next to the work dir, never inside it, so agents cannot read it. */
const gateDir = (dir: string) => `${dir}.gate`;
const withGate = (cmd: string, path: string) => cmd.replaceAll("{gate}", path);

/**
 * Gate cases: copy the suite next to the repo and add it to the repo's config as orch's `gateChecks`, before the fixture
 * commit (fixtures ignore `.orchestrator/`, so it stays untracked). Orch runs it; the agents only learn its name.
 */
function gateSetup(dir: string, c: Case) {
  if (!existsSync(gateSource(c))) fail(`${c.id}: no gate suite in evals/gate/${c.id}`);
  rmSync(gateDir(dir), { recursive: true, force: true });
  cpSync(gateSource(c), gateDir(dir), { recursive: true });
  const file = join(dir, ".orchestrator", "config.json");
  mkdirSync(dirname(file), { recursive: true });
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  cfg.gateChecks = { gate: withGate(c.gate!, slashes(gateDir(dir))) };
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}

/** Run a shell command in the repo; the whole output and its tail. */
function shell(cmd: string, dir: string, extraEnv: Record<string, string> = {}) {
  // Browser-graded cases (web-*) load evals/lib/page.mjs from here, group cases evals/lib/backend.mjs.
  const env = { ...process.env, YAAIORCH_EVALS: EVALS, ...extraEnv };
  const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8", timeout: 180_000, windowsHide: true, env });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  return { pass: r.status === 0, output, tail: output.trim().split(/\r?\n/).slice(-8).join("\n") };
}

/** The gate alone, from the pristine suite (`--reference`). */
const gateRun = (dir: string, c: Case) => shell(withGate(c.gate!, gateSource(c)), dir);

function grade(dir: string, c: Case) {
  if (c.group) {
    const g = gradeGroup(dir, c);
    return { pass: g.backend.pass && g.frontend.pass, tail: g.tail };
  }
  cpSync(join(EVALS, "hidden", c.id), dir, { recursive: true });
  // Gate cases grade with the pristine suite, never the run's copy.
  const r = shell(withGate(c.grade as string, gateSource(c)), dir);
  writeFileSync(join(dir, "..", `${dir.split(/[\\/]/).pop()}.grade.log`), r.output);
  return { pass: r.pass, tail: r.tail };
}

/** Both repos of a group case, each with its own hidden tests; the frontend's drive the run's backend (EVAL_BACKEND). */
function gradeGroup(dir: string, c: Case) {
  const d = groupDirs(dir);
  const out = {} as Record<Role, ReturnType<typeof shell>>;
  for (const role of ROLES) {
    cpSync(join(EVALS, "hidden", c.id, role), d[role], { recursive: true });
    out[role] = shell((c.grade as Record<Role, string>)[role], d[role], role === "frontend" ? { EVAL_BACKEND: d.backend } : {});
  }
  writeFileSync(join(dir, "..", `${dir.split(/[\\/]/).pop()}.grade.log`), ROLES.map((r) => `===== ${r}\n${out[r].output}`).join("\n"));
  const tail = ROLES.filter((r) => !out[r].pass)
    .map((r) => `[${r}]\n${out[r].tail}`)
    .join("\n");
  return { ...out, tail };
}

// ---------- --reference: validate the suite itself ----------
if (a.reference) {
  let bad = 0;
  console.log(`checking ${cases.length} case(s) in ${workRoot}\n`);
  for (const c of cases) {
    const ref = join(EVALS, "reference", c.id);
    if (!existsSync(join(EVALS, "hidden", c.id))) fail(`${c.id}: no hidden tests in evals/hidden/${c.id}`);
    if (!existsSync(ref)) fail(`${c.id}: no reference solution in evals/reference/${c.id}`);
    const untouched = join(workRoot, `${c.id}-untouched`);
    const solved = join(workRoot, `${c.id}-reference`);
    if (c.group) {
      setupGroup(untouched, c);
      setupGroup(solved, c, ref);
      const [before, after] = [gradeGroup(untouched, c), gradeGroup(solved, c)];
      // Each side's hidden tests must tell the fixture from the reference on their own.
      const weak = ROLES.filter((r) => before[r].pass);
      const broken = ROLES.filter((r) => !after[r].pass);
      if (weak.length || broken.length) bad++;
      console.log(
        `${weak.length || broken.length ? "BAD " : "ok  "} ${c.id.padEnd(20)} untouched fixture: ${weak.length ? `PASSES on ${weak.join(", ")} (tests too weak)` : "fails"}   reference: ${broken.length ? `FAILS on ${broken.join(", ")}` : "passes"}`,
      );
      if (broken.length) console.log(after.tail.replace(/^/gm, "       "));
      continue;
    }
    setupRepo(untouched, c);
    const before = grade(untouched, c);
    setupRepo(solved, c, [ref]);
    const after = grade(solved, c);
    // A gate case's gate must also tell the two apart on its own: it is what forces the fix round.
    const gate = c.gate ? { before: gateRun(untouched, c), after: gateRun(solved, c) } : null;
    const ok = !before.pass && after.pass && (!gate || (!gate.before.pass && gate.after.pass));
    if (!ok) bad++;
    console.log(
      `${ok ? "ok  " : "BAD "} ${c.id.padEnd(20)} untouched fixture: ${before.pass ? "PASSES (tests too weak)" : "fails"}   reference: ${after.pass ? "passes" : "FAILS"}` +
        (gate ? `   gate: ${gate.before.pass ? "PASSES untouched (too weak)" : "fails"} / ${gate.after.pass ? "passes" : "FAILS reference"}` : ""),
    );
    if (!after.pass) console.log(after.tail.replace(/^/gm, "       "));
    if (gate && !gate.after.pass) console.log(gate.after.tail.replace(/^/gm, "       "));
  }
  console.log(bad ? `\n${bad} case(s) need fixing` : "\nall cases discriminate: the hidden tests fail before and pass with the reference");
  process.exit(bad ? 1 : 0);
}

// ---------- normal mode: run orch and grade ----------
const orchArgs = a.orch ? [a.orch] : [join(ROOT, "orch-ui", "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "orch.ts")];
if (!existsSync(orchArgs[0])) fail(`${orchArgs[0]} not found (run "npm install" in orch-ui, or pass --orch)`);

function killTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OrchResult = { exit: number | null; events: any[]; seconds: number; timedOut: boolean };

function runOrch(dir: string, goal: string, power: string): Promise<OrchResult> {
  return spawnOrch(dir, [
    "run",
    goal,
    "--power",
    tierOf(power),
    ...suffixArgs(power),
    ...commonArgs(),
    "--max-rounds",
    a["max-rounds"]!,
    ...(a["usage-cap"] ? ["--usage-cap", a["usage-cap"]] : []),
    // Your own Claude Code plugins and hooks (skills, session-start instructions) would change what every agent
    // sees and costs, so results would depend on the machine. Off unless --user-plugins.
    ...(a["user-plugins"] ? [] : ["--plugins", "off", "--no-hooks"]),
  ]);
}

/** Options orch run and orch group run share. */
const commonArgs = () => [
  // The runner handles the usage limit itself (stop or --wait-on-limit), so orch must not wait.
  "--on-limit",
  "stop",
  ...(a["orch-model"] ? ["--model", a["orch-model"]] : []),
  "--max-cost",
  a["max-cost"]!,
  "--agent-timeout",
  a["agent-timeout"]!,
];

/**
 * A group case: `orch group run eval "<goal>"` from the run dir, with the run's own YAAIORCH_HOME. --max-cost covers
 * the whole group (orch splits it between the coordinator and the member runs); --max-rounds goes to every member
 * run; plugins are off through each repo's config (setupGroup). It gets twice the eval timeout: it runs a
 * coordinator, two builds, an integration check and maybe fixes.
 */
function runGroupOrch(dir: string, goal: string, power: string): Promise<OrchResult> {
  const parts = power.split("+").slice(1);
  return spawnOrch(
    dir,
    [
      "group",
      "run",
      "eval",
      "--power",
      tierOf(power),
      parts.includes("fast") ? "--fast" : "--no-fast",
      ...commonArgs(),
      "--max-rounds",
      a["max-rounds"]!,
      "--",
      goal,
    ],
    { YAAIORCH_HOME: groupDirs(dir).home },
    2,
  );
}

function spawnOrch(dir: string, orchCmd: string[], extraEnv: Record<string, string> = {}, timeoutFactor = 1): Promise<OrchResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = [...orchArgs, ...orchCmd];
    const env = { ...process.env, ORCH_EVENTS: "1", FORCE_COLOR: "0", ...(a["claude-bin"] ? { CLAUDE_BIN: a["claude-bin"] } : {}), ...extraEnv };
    const p = spawn(process.execPath, args, { cwd: dir, env, windowsHide: true, detached: process.platform !== "win32" });
    const log = join(dir, "..", `${dir.split(/[\\/]/).pop()}.orch.log`);
    const events: any[] = [];
    let rest = "";
    const onData = (d: Buffer) => {
      appendFileSync(log, d);
      const lines = (rest + d.toString("utf8")).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const l of lines)
        if (l.startsWith("@@ORCH@@ ")) {
          try {
            events.push(JSON.parse(l.slice(9)));
          } catch {
            /* ignore a broken line */
          }
        }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree(p.pid);
      },
      Number(a["eval-timeout"]) * 60_000 * timeoutFactor,
    );
    p.on("close", (exit) => {
      clearTimeout(timer);
      resolve({ exit, events, seconds: Math.round((Date.now() - start) / 1000), timedOut });
    });
  });
}

// ---------- single-agent control: one `claude -p` call with the same goal, permissions, budget and checks ----------
const CLAUDE = a["claude-bin"] ?? process.env.CLAUDE_BIN ?? "claude";
/** The control group's settings without the user's plugins and hooks, like orch's --plugins off --no-hooks (unless --user-plugins). */
let pluginsOff: { enabledPlugins?: Record<string, false>; disableAllHooks?: true } | undefined;
function noUserPlugins() {
  if (a["user-plugins"]) return {};
  if (!pluginsOff) {
    const r = spawnSync(CLAUDE_CMD.file, [...CLAUDE_CMD.pre, "plugin", "list", "--json"], {
      encoding: "utf8",
      shell: CLAUDE_CMD.shell,
      windowsHide: true,
      timeout: 60_000,
    });
    let ids: string[] = [];
    try {
      ids = (JSON.parse(r.stdout) as { id?: string; enabled?: boolean }[]).filter((p) => p.id && p.enabled !== false).map((p) => p.id!);
    } catch {
      /* no list: hooks are still disabled */
    }
    pluginsOff = { ...(ids.length ? { enabledPlugins: Object.fromEntries(ids.map((id) => [id, false as const])) } : {}), disableAllHooks: true };
  }
  return pluginsOff;
}
/** Started the same way orch.ts starts it: no shell on Windows (see claude-bin.ts). */
const CLAUDE_CMD = resolveClaude(CLAUDE);
if (CLAUDE_CMD.missing && a.single) throw new Error(`"${CLAUDE}" not found on PATH; install Claude Code or pass --claude-bin`);

/** The repo's check commands, found the same way orch.ts finds them. */
function checksIn(dir: string): Record<string, string> {
  const cfg = join(dir, ".orchestrator", "config.json");
  if (existsSync(cfg)) {
    const checks = JSON.parse(readFileSync(cfg, "utf8")).checks;
    if (checks) return checks;
  }
  const pkg = join(dir, "package.json");
  const scripts: Record<string, string> = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {}) : {};
  return Object.fromEntries(
    ["typecheck", "lint", "test", "build"].filter((s) => scripts[s] && !/no test specified/.test(scripts[s])).map((s) => [s, `npm run ${s}`]),
  );
}

type SingleResult = {
  exit: number | null;
  seconds: number;
  timedOut: boolean;
  result?: { result?: unknown; is_error?: boolean; subtype?: string; total_cost_usd?: number };
};

function runSingle(dir: string, goal: string, model: string): Promise<SingleResult> {
  const checks = checksIn(dir);
  const cmds = [...Object.values(checks), ...(checks.test ? ["npm test"] : []), "git status", "git diff", "git log", "git show"];
  const allow = cmds.flatMap((cmd) => [`Bash(${cmd}:*)`, `PowerShell(${cmd}:*)`]);
  mkdirSync(join(dir, ".orchestrator"), { recursive: true });
  writeFileSync(join(dir, ".orchestrator", "single-settings.json"), JSON.stringify({ permissions: { allow }, ...noUserPlugins() }, null, 2));
  const prompt =
    `Complete this task in the repository in the current directory.\n\nTask: ${goal}\n\n` +
    `Follow the repository's existing conventions and add or update tests. ` +
    `You can run the repository's checks: ${Object.values(checks).join(", ") || "none are configured"}.\n` +
    `When you are done, end your reply with exactly one of these lines: "Status: COMPLETE", "Status: PARTIAL" or "Status: FAILED".`;
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--settings",
    ".orchestrator/single-settings.json",
    "--max-budget-usd",
    a["max-cost"]!,
  ];
  return new Promise((resolve) => {
    const start = Date.now();
    const p = spawn(CLAUDE_CMD.file, [...CLAUDE_CMD.pre, ...args], {
      cwd: dir,
      shell: CLAUDE_CMD.shell,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const log = join(dir, "..", `${dir.split(/[\\/]/).pop()}.single.log`);
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => (out += d));
    p.stderr.on("data", (d: Buffer) => appendFileSync(log, d));
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree(p.pid);
      },
      Number(a["eval-timeout"]) * 60_000,
    );
    p.on("close", (exit) => {
      clearTimeout(timer);
      appendFileSync(log, out);
      let result;
      try {
        result = JSON.parse(out);
      } catch {
        /* no JSON: recorded as an error */
      }
      resolve({ exit, seconds: Math.round((Date.now() - start) / 1000), timedOut, result });
    });
    p.stdin.end(prompt);
  });
}

const resultsDir = join(EVALS, "results");
mkdirSync(resultsDir, { recursive: true });
const jsonl = join(resultsDir, `${stamp}.jsonl`);
const runs: Run[] = [];
const key = (caseId: string, power: string, rep: number) => `${caseId}|${power}|${rep}`;

// --resume: keep the finished runs, drop the ones a usage limit spoiled, and run only what is missing.
if (a.resume) {
  if (!existsSync(jsonl)) fail(`no results to resume: ${jsonl}`);
  const old: Run[] = readFileSync(jsonl, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const kept = old.filter((r) => !LIMIT_RE.test(r.error ?? ""));
  writeFileSync(jsonl, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
  runs.push(...kept);
  console.log(`resuming ${stamp}: ${kept.length} run(s) kept, ${old.length - kept.length} spoiled by the usage limit dropped`);
}
const done = new Set(runs.map((r) => key(r.case, r.power, r.rep)));

type Job = { c: Case; power: string; rep: number };
const jobs: Job[] = [];
/** Set when the usage limit stops the eval (without --wait-on-limit). */
let stoppedBy = "";
/** With --wait-on-limit: no new run starts before this time. */
let pausedUntil = 0;

/** Usage limit hit: never recorded; pause (--wait-on-limit) or stop, and put the job back. */
function onLimit(job: Job, resetAt?: number, why = "usage limit") {
  const { c, power, rep } = job;
  jobs.unshift(job);
  if (a["wait-on-limit"]) {
    pausedUntil = Math.max(pausedUntil, (resetAt ?? Date.now() + 29 * 60_000) + 60_000);
    console.log(`limit ${c.id} ${power} #${rep}: ${why}; pausing until ${new Date(pausedUntil).toLocaleString()}, then retrying`);
  } else {
    if (!stoppedBy) stoppedBy = `Claude ${why}${resetAt ? ` (resets ${new Date(resetAt).toLocaleString()})` : ""}`;
    console.log(`limit ${c.id} ${power} #${rep}: ${why}; stopping (no new runs start)`);
  }
}

function record(run: Run) {
  runs.push(run);
  appendFileSync(jsonl, JSON.stringify(run) + "\n");
  console.log(
    `${run.hidden ? "PASS" : "fail"} ${run.case.padEnd(20)} ${run.power.padEnd(14)} #${run.rep}  claimed=${run.claimed ? "pass" : "fail"}  rounds=${run.rounds}  ` +
      `$${run.cost.toFixed(2)}  ${run.seconds}s${run.stuck ? `  stuck=${run.stuck}` : ""}${run.error ? `  (${run.error.slice(0, 80)})` : ""}`,
  );
}

async function oneSingle(job: Job, model: string) {
  const { c, power, rep } = job;
  const dir = join(workRoot, `${c.id}-${power.replace(":", "-")}-${rep}`);
  rmSync(dir, { recursive: true, force: true });
  setupRepo(dir, c);
  // A series: one call per goal, in order, on the same repo (the single agent keeps no memory between them).
  let claimed = true,
    cost = 0,
    seconds = 0,
    error: string | undefined,
    last: SingleResult | undefined;
  for (const goal of goalsOf(c)) {
    const r = (last = await runSingle(dir, goal, model));
    const text = typeof r.result?.result === "string" ? r.result.result : "";
    if ((r.result?.is_error || r.exit !== 0) && LIMIT_RE.test(text)) return onLimit(job);
    const failed = r.timedOut || !r.result || r.result.is_error || r.exit !== 0;
    claimed &&= !failed && /Status:\s*COMPLETE/i.test(text);
    cost += r.result?.total_cost_usd ?? 0;
    seconds += r.seconds;
    error ??= r.timedOut
      ? "eval timeout"
      : !r.result
        ? `claude exited ${r.exit} without JSON`
        : failed
          ? `claude: ${r.result.subtype ?? `exit ${r.exit}`} ${text.slice(0, 120)}`.trim()
          : undefined;
  }
  const g = grade(dir, c);
  record({
    case: c.id,
    kind: c.kind,
    difficulty: c.difficulty,
    power,
    rep,
    runner: "single",
    claimed,
    hidden: g.pass,
    rounds: goalsOf(c).length,
    cost,
    seconds,
    stuck: 0,
    goals: goalsOf(c).length,
    error,
    exit: last?.exit ?? null,
    timedOut: !!last?.timedOut,
    dir,
    gradeTail: g.pass ? "" : g.tail,
  });
}

/**
 * A group case's run: the group's own events plus its member runs' (`group_child`, unwrapped). Cost is the
 * coordinator's (group_plan, group_fault) plus every member run's goal_end; rounds are summed over the member runs,
 * and `goals` is the number of member runs, so "round 2+" means one of them needed a fix round.
 */
async function oneGroup(job: Job) {
  const { c, power, rep } = job;
  const dir = join(workRoot, `${c.id}-${power}-${rep}`);
  rmSync(dir, { recursive: true, force: true });
  setupGroup(dir, c);
  const capped = capReached();
  if (capped) return onLimit(job, capped.resetAt, capped.what);
  const r = await runGroupOrch(dir, c.goal!, power);
  const own = r.events.filter((e) => e.type !== "group_child");
  const members = r.events.filter((e) => e.type === "group_child" && e.event).map((e) => e.event);
  noteUsage(members);
  const end = [...own].reverse().find((e) => e.type === "group_end");
  const memberEnds = members.filter((e) => e.type === "goal_end");
  // Usage limit (--on-limit stop): the group parks both repos and exits 3; not a result.
  if (r.exit === 3 || memberEnds.some((e) => e.usageLimit)) return onLimit(job, memberEnds.find((e) => e.resetAt)?.resetAt);
  const cost =
    own.filter((e) => e.type === "group_plan" || e.type === "group_fault").reduce((s, e) => s + (Number(e.cost) || 0), 0) +
    memberEnds.reduce((s, e) => s + (Number(e.cost) || 0), 0);
  const rounds = members.filter((e) => e.type === "round_start");
  const g = grade(dir, c);
  record({
    case: c.id,
    kind: c.kind,
    difficulty: c.difficulty,
    power,
    rep,
    runner: "orch",
    claimed: !!end?.ok,
    hidden: g.pass,
    rounds: rounds.length,
    cost: Math.round(cost * 10_000) / 10_000,
    seconds: r.seconds,
    goals: memberEnds.length,
    stuck: members.filter((e) => e.type === "stuck").length,
    faults: own.filter((e) => e.type === "group_fault").length,
    finalPower: rounds.at(-1)?.power,
    error: r.timedOut ? "eval timeout" : end ? (end.ok ? undefined : (end.reason ?? "group failed")) : `orch exited ${r.exit} without group_end`,
    exit: r.exit,
    timedOut: r.timedOut,
    dir,
    gradeTail: g.pass ? "" : g.tail,
  });
}

async function one(job: Job) {
  const { c, power, rep } = job;
  if (c.group) return oneGroup(job);
  if (power.startsWith("single:")) return oneSingle(job, power.slice("single:".length));
  const dir = join(workRoot, `${c.id}-${power}-${rep}`);
  rmSync(dir, { recursive: true, force: true }); // a retried run starts from a clean copy
  setupRepo(dir, c);
  // A series runs its goals in turn on the same repo; a failed goal does not stop the next one (a user
  // would go on too), and the series counts as claimed only if every goal passed.
  const all: any[] = [];
  let claimed = true,
    cost = 0,
    seconds = 0,
    error: string | undefined;
  let last: Awaited<ReturnType<typeof runOrch>> | undefined;
  for (const [i, goal] of goalsOf(c).entries()) {
    const capped = capReached();
    if (capped) return onLimit(job, capped.resetAt, capped.what);
    const r = (last = await runOrch(dir, goal, power));
    noteUsage(r.events);
    const end = [...r.events].reverse().find((e) => e.type === "goal_end");
    // Usage limit: not the orchestrator's fault and not a result.
    if (r.exit === 3 || end?.usageLimit) return onLimit(job, end?.resetAt);
    all.push(...r.events);
    claimed &&= !!end?.passed;
    cost += end?.cost ?? 0;
    seconds += r.seconds;
    const why = r.timedOut ? "eval timeout" : (end?.error ?? (end ? undefined : `orch exited ${r.exit} without goal_end`));
    if (why && !error) error = goalsOf(c).length > 1 ? `goal ${i + 1}: ${why}` : why;
  }
  const g = grade(dir, c);
  const rounds = all.filter((e) => e.type === "round_start");
  record({
    case: c.id,
    kind: c.kind,
    difficulty: c.difficulty,
    power,
    rep,
    runner: "orch",
    claimed,
    hidden: g.pass,
    rounds: rounds.length,
    cost: Math.round(cost * 10_000) / 10_000,
    seconds,
    goals: goalsOf(c).length,
    stuck: all.filter((e) => e.type === "stuck").length,
    finalPower: rounds.at(-1)?.power,
    error,
    exit: last?.exit ?? null,
    timedOut: !!last?.timedOut,
    dir,
    gradeTail: g.pass ? "" : g.tail,
  });
}

for (const c of cases)
  for (const power of configs)
    for (let rep = 1; rep <= Number(a.repeat); rep++)
      // The single-agent control works in one repo; a group case has two, so it has no control run.
      if (!done.has(key(c.id, power, rep)) && !(c.group && power.startsWith("single:"))) jobs.push({ c, power, rep });
console.log(`${jobs.length} run(s) to do: ${cases.length} case(s) x ${configs.join("/")} x ${a.repeat}, ${a.parallel} at a time`);
console.log(`work dirs: ${workRoot}\nresults:   ${jsonl}\n`);

const workers = Array.from({ length: Math.max(1, Number(a.parallel)) }, async () => {
  while (!stoppedBy && jobs.length) {
    while (pausedUntil > Date.now() && !stoppedBy) await sleep(Math.min(5000, pausedUntil - Date.now()));
    const job = jobs.shift();
    if (!job) break;
    // Not even one more call over the cap: a new orch would only learn the usage from its first call.
    const capped = capReached();
    if (capped) {
      onLimit(job, capped.resetAt, capped.what);
      continue;
    }
    await one(job);
  }
});
await Promise.all(workers);

// ---------- summary ----------
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
/** A fix round happened: more rounds than goals (one round per goal is a first-try pass). */
const reachedFixRound = (r: Run) => r.rounds > (r.goals ?? 1);
/** Every other option that changes what a run does, so a resumed eval runs the same way (quoted for a shell). */
function resumeOptions(): string {
  const q = (v: string) => (/^[\w.,:=+/-]+$/.test(v) ? v : `"${v}"`);
  const keep = ["orch", "orch-model", "claude-bin", "max-rounds", "max-cost", "agent-timeout", "eval-timeout", "parallel"] as const;
  const defaults: Record<string, string> = { "max-rounds": "4", "max-cost": "3", "agent-timeout": "15", "eval-timeout": "30", parallel: "1" };
  return keep
    .filter((k) => a[k] !== undefined && a[k] !== defaults[k])
    .map((k) => ` --${k} ${q(String(a[k]))}`)
    .join("");
}
const lines: string[] = [];
lines.push(`# Eval ${stamp}`, "");
lines.push(`Cases: ${cases.map((c) => c.id).join(", ")}  `);
lines.push(
  `Settings: max-rounds ${a["max-rounds"]}, max-cost $${a["max-cost"]}, repeat ${a.repeat}${a["orch-model"] ? `, orch models ${a["orch-model"]}` : ""}${a["claude-bin"] ? `, claude-bin ${a["claude-bin"]}` : ""}${a["user-plugins"] ? ", with your plugins and hooks" : ", without plugins or hooks"}${a["usage-cap"] ? `, usage cap ${a["usage-cap"]}` : ""}`,
  "",
);
if (stoppedBy)
  lines.push(
    `**Stopped early: ${stoppedBy}.** ${jobs.length} run(s) not done. Finish with:`,
    "",
    "```",
    `node evals/run.ts --resume ${stamp} --power ${powers.join(",") || "none"}${singles.length ? ` --single ${singles.join(",")}` : ""} --repeat ${a.repeat}${wanted ? ` --cases ${wanted.join(",")}` : ""}${a["usage-cap"] ? ` --usage-cap ${a["usage-cap"]}` : ""}${a["user-plugins"] ? " --user-plugins" : ""}${resumeOptions()}`,
    "```",
    "",
  );
lines.push("## By configuration", "");
lines.push("Orch tiers run the full loop; `single:<model>` is the control group: one `claude -p` call with the same goal, permissions, checks and budget.", "");
lines.push("| config | runs | hidden pass | claimed pass | false pass | avg rounds | round 2+ | stuck | avg cost | avg time | total cost |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const p of configs) {
  const rs = runs.filter((r) => r.power === p);
  lines.push(
    `| ${p} | ${rs.length} | ${pct(rs.filter((r) => r.hidden).length, rs.length)} | ${pct(rs.filter((r) => r.claimed).length, rs.length)} | ` +
      `${rs.filter((r) => r.claimed && !r.hidden).length} | ${avg(rs.map((r) => r.rounds)).toFixed(1)} | ` +
      `${pct(rs.filter(reachedFixRound).length, rs.length)} | ${rs.filter((r) => r.stuck > 0).length} | $${avg(rs.map((r) => r.cost)).toFixed(2)} | ` +
      `${(avg(rs.map((r) => r.seconds)) / 60).toFixed(1)} min | $${rs.reduce((s, r) => s + r.cost, 0).toFixed(2)} |`,
  );
}
lines.push(
  "",
  "False pass: the run reported success (orch: QA passed; single: Status: COMPLETE) but the hidden tests failed. " +
    "Round 2+: runs that needed a fix round (in a series, more rounds than goals). Stuck: runs with a stuck round (power escalated).",
  "",
);
if (cases.some((c) => c.goals))
  lines.push(
    "Series cases run several goals in a row on one repo; their rounds and cost are totals over all goals, and they count as claimed only if every goal passed.",
    "",
  );
if (cases.some((c) => c.group))
  lines.push(
    "Group cases run `orch group run` across a backend and a frontend repo and pass only when both repos' hidden tests do (the frontend's drive the web client against the backend the run built). " +
      "Their rounds are summed over the member runs (builds, integration check, fixes), round 2+ means a member run needed a fix round, and claimed is the group's own verdict. " +
      "In the table, `Nfix` counts integration fix calls (a failed integration check blamed a side). They have no single-agent control run.",
    "",
  );
lines.push("## By case", "");
lines.push(`| case | kind | ${configs.join(" | ")} |`);
lines.push(`|---|---|${configs.map(() => "---").join("|")}|`);
for (const c of cases) {
  const cell = (p: string) =>
    runs
      .filter((r) => r.case === c.id && r.power === p)
      .map((r) => `${r.hidden ? "✓" : r.claimed ? "✗ (claimed ✓)" : "✗"} ${r.rounds}r${r.faults ? ` ${r.faults}fix` : ""} $${r.cost.toFixed(2)}`)
      .join("<br>") || "-";
  lines.push(`| ${c.id} | ${c.kind} | ${configs.map(cell).join(" | ")} |`);
}
const failed = runs.filter((r) => !r.hidden);
if (failed.length) {
  lines.push("", "## Failures", "");
  for (const r of failed) {
    lines.push(`### ${r.case} (${r.power} #${r.rep})`, "");
    lines.push(`Work dir: \`${r.dir}\`${r.error ? `  \nError: ${r.error}` : ""}`, "", "```", r.gradeTail || "(no grade output)", "```", "");
  }
}
const md = lines.join("\n");
writeFileSync(join(resultsDir, `${stamp}.md`), md + "\n");
console.log("\n" + md.split("\n## Failures")[0]);
console.log(`\nsummary: ${join(resultsDir, `${stamp}.md`)}`);
process.exit(stoppedBy ? 3 : 0);
