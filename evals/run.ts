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
//                                                                              "economy+fast" adds orch's --fast)
//   --single m1,m2       also run a single agent with these models (control group), e.g. sonnet,opus
//   --orch-model SPEC    passed to orch as --model for every orch run, e.g. "architect=opus,impl=haiku"
//   --repeat N           runs per case and tier (1)       --parallel N           runs at once (1)
//   --max-rounds N       passed to orch (4)               --max-cost USD         per run, passed to orch (3)
//   --agent-timeout MIN  passed to orch (15)              --eval-timeout MIN     kill a whole run after (30)
//   --claude-bin PATH    use another claude (a fake, to test the runner without spending tokens)
//   --orch PATH          run this orch.mjs instead of ../orch.ts through tsx
//   --wait-on-limit      on a Claude usage limit, pause until the reset and carry on (default: stop)
//   --resume STAMP       finish results/STAMP.jsonl: skip runs already recorded, drop ones a usage limit spoiled
//
// A run cut short by the usage limit (orch exit code 3) is never recorded as a failure.
//
// Each run copies a fixture into a fresh git repo under the OS temp dir, runs `orch run "<goal>"` there,
// then copies the case's hidden tests in (agents never see them) and runs the case's grade command.
// Results: evals/results/<stamp>.jsonl (one line per run) and <stamp>.md (summary). Work dirs are kept.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Case = { id: string; fixture: string; kind: string; difficulty: string; goal: string; grade: string };
/** `power` is the configuration label: an orch tier ("economy"), or "single:<model>" for the control group. */
type Run = {
  case: string; kind: string; difficulty: string; power: string; rep: number; runner?: "orch" | "single";
  claimed: boolean; hidden: boolean; rounds: number; cost: number; seconds: number;
  stuck: number; finalPower?: string; error?: string; exit: number | null; timedOut: boolean; dir: string; gradeTail: string;
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
    orch: { type: "string" },
    "wait-on-limit": { type: "boolean", default: false },
    resume: { type: "string" },
  },
});
/** Same wording orch.ts matches; also catches records an older orch wrote as plain failures. */
const LIMIT_RE = /\b(?:hit|reached) your [^\n.]{0,40}?limit\b/i;

const allCases: Case[] = JSON.parse(readFileSync(join(EVALS, "cases.json"), "utf8"));
const wanted = a.cases?.split(",").map((s) => s.trim()).filter(Boolean);
const unknown = wanted?.filter((id) => !allCases.some((c) => c.id === id)) ?? [];
if (unknown.length) fail(`unknown case(s): ${unknown.join(", ")}. Known: ${allCases.map((c) => c.id).join(", ")}`);
const cases = wanted ? allCases.filter((c) => wanted.includes(c.id)) : allCases;
const powers = a.power === "none" ? [] : a.power!.split(",").map((s) => s.trim()).filter(Boolean);
// "economy+fast" runs orch with --fast (direct attempt first).
const tierOf = (label: string) => label.replace(/\+fast$/, "");
for (const p of powers) if (!TIERS.includes(tierOf(p))) fail(`unknown power "${p}"; use ${TIERS.join(", ")} (optionally +fast) or none`);
const singles = (a.single ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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
function setupRepo(dir: string, c: Case, ...overlays: string[]) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(EVALS, "fixtures", c.fixture), dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=evals", "-c", "user.email=evals@localhost", "add", "-A");
  git("-c", "user.name=evals", "-c", "user.email=evals@localhost", "commit", "-q", "-m", `fixture ${c.fixture}`);
  // Commits made by orch use the repo's identity; give the throwaway repo one.
  git("config", "user.name", "evals");
  git("config", "user.email", "evals@localhost");
  for (const o of overlays) cpSync(o, dir, { recursive: true });
}

function grade(dir: string, c: Case) {
  cpSync(join(EVALS, "hidden", c.id), dir, { recursive: true });
  const r = spawnSync(c.grade, { cwd: dir, shell: true, encoding: "utf8", timeout: 180_000, windowsHide: true });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  writeFileSync(join(dir, "..", `${dir.split(/[\\/]/).pop()}.grade.log`), output);
  return { pass: r.status === 0, tail: output.trim().split(/\r?\n/).slice(-8).join("\n") };
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
    setupRepo(untouched, c);
    const before = grade(untouched, c);
    const solved = join(workRoot, `${c.id}-reference`);
    setupRepo(solved, c, ref);
    const after = grade(solved, c);
    const ok = !before.pass && after.pass;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${c.id.padEnd(20)} untouched fixture: ${before.pass ? "PASSES (tests too weak)" : "fails"}   reference: ${after.pass ? "passes" : "FAILS"}`);
    if (!after.pass) console.log(after.tail.replace(/^/gm, "       "));
  }
  console.log(bad ? `\n${bad} case(s) need fixing` : "\nall cases discriminate: the hidden tests fail before and pass with the reference");
  process.exit(bad ? 1 : 0);
}

// ---------- normal mode: run orch and grade ----------
const orchArgs = a.orch
  ? [a.orch]
  : [join(ROOT, "orch-ui", "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "orch.ts")];
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

function runOrch(dir: string, c: Case, power: string): Promise<{ exit: number | null; events: any[]; seconds: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = [
      ...orchArgs, "run", c.goal,
      "--power", tierOf(power),
      ...(power.endsWith("+fast") ? ["--fast"] : []),
      // The runner handles the usage limit itself (stop or --wait-on-limit), so orch must not wait.
      "--on-limit", "stop",
      ...(a["orch-model"] ? ["--model", a["orch-model"]] : []),
      "--max-rounds", a["max-rounds"]!,
      "--max-cost", a["max-cost"]!,
      "--agent-timeout", a["agent-timeout"]!,
    ];
    const env = { ...process.env, ORCH_EVENTS: "1", FORCE_COLOR: "0", ...(a["claude-bin"] ? { CLAUDE_BIN: a["claude-bin"] } : {}) };
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
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p.pid);
    }, Number(a["eval-timeout"]) * 60_000);
    p.on("close", (exit) => {
      clearTimeout(timer);
      resolve({ exit, events, seconds: Math.round((Date.now() - start) / 1000), timedOut });
    });
  });
}

// ---------- single-agent control: one `claude -p` call with the same goal, permissions, budget and checks ----------
const CLAUDE = a["claude-bin"] ?? process.env.CLAUDE_BIN ?? "claude";
/** cmd.exe joins the command line unquoted, so quote a path with spaces (as orch.ts does). */
const shellCmd = (cmd: string) => (process.platform === "win32" && /\s/.test(cmd) && !cmd.startsWith('"') ? `"${cmd}"` : cmd);

/** The repo's check commands, found the same way orch.ts finds them. */
function checksIn(dir: string): Record<string, string> {
  const cfg = join(dir, ".orchestrator", "config.json");
  if (existsSync(cfg)) {
    const checks = JSON.parse(readFileSync(cfg, "utf8")).checks;
    if (checks) return checks;
  }
  const pkg = join(dir, "package.json");
  const scripts: Record<string, string> = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {} : {};
  return Object.fromEntries(
    ["typecheck", "lint", "test", "build"].filter((s) => scripts[s] && !/no test specified/.test(scripts[s])).map((s) => [s, `npm run ${s}`]),
  );
}

type SingleResult = { exit: number | null; seconds: number; timedOut: boolean; result?: { result?: unknown; is_error?: boolean; subtype?: string; total_cost_usd?: number } };

function runSingle(dir: string, c: Case, model: string): Promise<SingleResult> {
  const checks = checksIn(dir);
  const cmds = [...Object.values(checks), ...(checks.test ? ["npm test"] : []), "git status", "git diff", "git log", "git show"];
  const allow = cmds.flatMap((cmd) => [`Bash(${cmd}:*)`, `PowerShell(${cmd}:*)`]);
  mkdirSync(join(dir, ".orchestrator"), { recursive: true });
  writeFileSync(join(dir, ".orchestrator", "single-settings.json"), JSON.stringify({ permissions: { allow } }, null, 2));
  const prompt =
    `Complete this task in the repository in the current directory.\n\nTask: ${c.goal}\n\n` +
    `Follow the repository's existing conventions and add or update tests. ` +
    `You can run the repository's checks: ${Object.values(checks).join(", ") || "none are configured"}.\n` +
    `When you are done, end your reply with exactly one of these lines: "Status: COMPLETE", "Status: PARTIAL" or "Status: FAILED".`;
  const args = [
    "-p", "--model", model, "--output-format", "json",
    "--permission-mode", "acceptEdits", "--settings", ".orchestrator/single-settings.json",
    "--max-budget-usd", a["max-cost"]!,
  ];
  return new Promise((resolve) => {
    const start = Date.now();
    const p = spawn(shellCmd(CLAUDE), args, {
      cwd: dir, shell: process.platform === "win32", windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const log = join(dir, "..", `${dir.split(/[\\/]/).pop()}.single.log`);
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => (out += d));
    p.stderr.on("data", (d: Buffer) => appendFileSync(log, d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p.pid);
    }, Number(a["eval-timeout"]) * 60_000);
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
  const old: Run[] = readFileSync(jsonl, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
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
function onLimit(job: Job, resetAt?: number) {
  const { c, power, rep } = job;
  jobs.unshift(job);
  if (a["wait-on-limit"]) {
    pausedUntil = Math.max(pausedUntil, (resetAt ?? Date.now() + 29 * 60_000) + 60_000);
    console.log(`limit ${c.id} ${power} #${rep}: usage limit; pausing until ${new Date(pausedUntil).toLocaleString()}, then retrying`);
  } else {
    if (!stoppedBy) stoppedBy = `Claude usage limit${resetAt ? ` (resets ${new Date(resetAt).toLocaleString()})` : ""}`;
    console.log(`limit ${c.id} ${power} #${rep}: usage limit; stopping (no new runs start)`);
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
  const r = await runSingle(dir, c, model);
  const text = typeof r.result?.result === "string" ? r.result.result : "";
  if ((r.result?.is_error || r.exit !== 0) && LIMIT_RE.test(text)) return onLimit(job);
  const g = grade(dir, c);
  const failed = r.timedOut || !r.result || r.result.is_error || r.exit !== 0;
  record({
    case: c.id, kind: c.kind, difficulty: c.difficulty, power, rep, runner: "single",
    claimed: !failed && /Status:\s*COMPLETE/i.test(text), hidden: g.pass,
    rounds: 1, cost: r.result?.total_cost_usd ?? 0, seconds: r.seconds, stuck: 0,
    error: r.timedOut ? "eval timeout" : !r.result ? `claude exited ${r.exit} without JSON` : failed ? `claude: ${r.result.subtype ?? `exit ${r.exit}`} ${text.slice(0, 120)}`.trim() : undefined,
    exit: r.exit, timedOut: r.timedOut, dir, gradeTail: g.pass ? "" : g.tail,
  });
}

async function one(job: Job) {
  const { c, power, rep } = job;
  if (power.startsWith("single:")) return oneSingle(job, power.slice("single:".length));
  const dir = join(workRoot, `${c.id}-${power}-${rep}`);
  rmSync(dir, { recursive: true, force: true }); // a retried run starts from a clean copy
  setupRepo(dir, c);
  const r = await runOrch(dir, c, power);
  const end = [...r.events].reverse().find((e) => e.type === "goal_end");
  // Usage limit: not the orchestrator's fault and not a result.
  if (r.exit === 3 || end?.usageLimit) return onLimit(job, end?.resetAt);
  const g = grade(dir, c);
  const rounds = r.events.filter((e) => e.type === "round_start");
  record({
    case: c.id, kind: c.kind, difficulty: c.difficulty, power, rep, runner: "orch",
    claimed: !!end?.passed, hidden: g.pass,
    rounds: rounds.length, cost: end?.cost ?? 0, seconds: r.seconds,
    stuck: r.events.filter((e) => e.type === "stuck").length,
    finalPower: rounds.at(-1)?.power,
    error: r.timedOut ? "eval timeout" : end?.error ?? (end ? undefined : `orch exited ${r.exit} without goal_end`),
    exit: r.exit, timedOut: r.timedOut, dir, gradeTail: g.pass ? "" : g.tail,
  });
}

for (const c of cases)
  for (const power of configs)
    for (let rep = 1; rep <= Number(a.repeat); rep++) if (!done.has(key(c.id, power, rep))) jobs.push({ c, power, rep });
console.log(`${jobs.length} run(s) to do: ${cases.length} case(s) x ${configs.join("/")} x ${a.repeat}, ${a.parallel} at a time`);
console.log(`work dirs: ${workRoot}\nresults:   ${jsonl}\n`);

const workers = Array.from({ length: Math.max(1, Number(a.parallel)) }, async () => {
  while (!stoppedBy && jobs.length) {
    while (pausedUntil > Date.now() && !stoppedBy) await sleep(Math.min(5000, pausedUntil - Date.now()));
    const job = jobs.shift();
    if (!job) break;
    await one(job);
  }
});
await Promise.all(workers);

// ---------- summary ----------
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const lines: string[] = [];
lines.push(`# Eval ${stamp}`, "");
lines.push(`Cases: ${cases.map((c) => c.id).join(", ")}  `);
lines.push(`Settings: max-rounds ${a["max-rounds"]}, max-cost $${a["max-cost"]}, repeat ${a.repeat}${a["orch-model"] ? `, orch models ${a["orch-model"]}` : ""}${a["claude-bin"] ? `, claude-bin ${a["claude-bin"]}` : ""}`, "");
if (stoppedBy)
  lines.push(
    `**Stopped early: ${stoppedBy}.** ${jobs.length} run(s) not done. Finish with:`, "",
    "```",
    `node evals/run.ts --resume ${stamp} --power ${powers.join(",") || "none"}${singles.length ? ` --single ${singles.join(",")}` : ""} --repeat ${a.repeat}${wanted ? ` --cases ${wanted.join(",")}` : ""}`,
    "```", "",
  );
lines.push("## By configuration", "");
lines.push("Orch tiers run the full loop; `single:<model>` is the control group: one `claude -p` call with the same goal, permissions, checks and budget.", "");
lines.push("| config | runs | hidden pass | claimed pass | false pass | avg rounds | avg cost | avg time | total cost |");
lines.push("|---|---|---|---|---|---|---|---|---|");
for (const p of configs) {
  const rs = runs.filter((r) => r.power === p);
  lines.push(
    `| ${p} | ${rs.length} | ${pct(rs.filter((r) => r.hidden).length, rs.length)} | ${pct(rs.filter((r) => r.claimed).length, rs.length)} | ` +
      `${rs.filter((r) => r.claimed && !r.hidden).length} | ${avg(rs.map((r) => r.rounds)).toFixed(1)} | $${avg(rs.map((r) => r.cost)).toFixed(2)} | ` +
      `${(avg(rs.map((r) => r.seconds)) / 60).toFixed(1)} min | $${rs.reduce((s, r) => s + r.cost, 0).toFixed(2)} |`,
  );
}
lines.push("", "False pass: the run reported success (orch: QA passed; single: Status: COMPLETE) but the hidden tests failed.", "");
lines.push("## By case", "");
lines.push(`| case | kind | ${configs.join(" | ")} |`);
lines.push(`|---|---|${configs.map(() => "---").join("|")}|`);
for (const c of cases) {
  const cell = (p: string) =>
    runs
      .filter((r) => r.case === c.id && r.power === p)
      .map((r) => `${r.hidden ? "✓" : r.claimed ? "✗ (claimed ✓)" : "✗"} ${r.rounds}r $${r.cost.toFixed(2)}`)
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
