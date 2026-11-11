// YAAIORCH eval runner. Node 22.18+ / 23.6+ runs this file directly (type stripping).
//
//   node evals/run.ts --reference                 check the suite itself: hidden tests fail on the
//                                                 untouched fixture and pass with the reference solution
//   node evals/run.ts [options]                   run orch on every case x power tier, grade with hidden tests
//
// Options:
//   --cases a,b          case ids (default: all)          --power economy,heavy  tiers (default: economy)
//   --repeat N           runs per case and tier (1)       --parallel N           runs at once (1)
//   --max-rounds N       passed to orch (4)               --max-cost USD         per run, passed to orch (3)
//   --agent-timeout MIN  passed to orch (15)              --eval-timeout MIN     kill a whole run after (30)
//   --claude-bin PATH    use another claude (a fake, to test the runner without spending tokens)
//   --orch PATH          run this orch.mjs instead of ../orch.ts through tsx
//
// Each run copies a fixture into a fresh git repo under the OS temp dir, runs `orch run "<goal>"` there,
// then copies the case's hidden tests in (agents never see them) and runs the case's grade command.
// Results: evals/results/<stamp>.jsonl (one line per run) and <stamp>.md (summary). Work dirs are kept.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Case = { id: string; fixture: string; kind: string; difficulty: string; goal: string; grade: string };
type Run = {
  case: string; kind: string; difficulty: string; power: string; rep: number;
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
    repeat: { type: "string", default: "1" },
    parallel: { type: "string", default: "1" },
    "max-rounds": { type: "string", default: "4" },
    "max-cost": { type: "string", default: "3" },
    "agent-timeout": { type: "string", default: "15" },
    "eval-timeout": { type: "string", default: "30" },
    "claude-bin": { type: "string" },
    orch: { type: "string" },
  },
});

const allCases: Case[] = JSON.parse(readFileSync(join(EVALS, "cases.json"), "utf8"));
const wanted = a.cases?.split(",").map((s) => s.trim()).filter(Boolean);
const unknown = wanted?.filter((id) => !allCases.some((c) => c.id === id)) ?? [];
if (unknown.length) fail(`unknown case(s): ${unknown.join(", ")}. Known: ${allCases.map((c) => c.id).join(", ")}`);
const cases = wanted ? allCases.filter((c) => wanted.includes(c.id)) : allCases;
const powers = a.power!.split(",").map((s) => s.trim());
for (const p of powers) if (!TIERS.includes(p)) fail(`unknown power "${p}"; use ${TIERS.join(", ")}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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
    console.log(`${ok ? "ok  " : "BAD "} ${c.id.padEnd(18)} untouched fixture: ${before.pass ? "PASSES (tests too weak)" : "fails"}   reference: ${after.pass ? "passes" : "FAILS"}`);
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

function runOrch(dir: string, c: Case, power: string): Promise<{ exit: number | null; events: any[]; seconds: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = [
      ...orchArgs, "run", c.goal,
      "--power", power,
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

const resultsDir = join(EVALS, "results");
mkdirSync(resultsDir, { recursive: true });
const jsonl = join(resultsDir, `${stamp}.jsonl`);
const runs: Run[] = [];

async function one(c: Case, power: string, rep: number) {
  const dir = join(workRoot, `${c.id}-${power}-${rep}`);
  setupRepo(dir, c);
  const r = await runOrch(dir, c, power);
  const end = [...r.events].reverse().find((e) => e.type === "goal_end");
  const g = grade(dir, c);
  const rounds = r.events.filter((e) => e.type === "round_start");
  const run: Run = {
    case: c.id, kind: c.kind, difficulty: c.difficulty, power, rep,
    claimed: !!end?.passed, hidden: g.pass,
    rounds: rounds.length, cost: end?.cost ?? 0, seconds: r.seconds,
    stuck: r.events.filter((e) => e.type === "stuck").length,
    finalPower: rounds.at(-1)?.power,
    error: r.timedOut ? "eval timeout" : end?.error ?? (end ? undefined : `orch exited ${r.exit} without goal_end`),
    exit: r.exit, timedOut: r.timedOut, dir, gradeTail: g.pass ? "" : g.tail,
  };
  runs.push(run);
  appendFileSync(jsonl, JSON.stringify(run) + "\n");
  const mark = run.hidden ? "PASS" : "fail";
  console.log(
    `${mark} ${c.id.padEnd(18)} ${power.padEnd(8)} #${rep}  claimed=${run.claimed ? "pass" : "fail"}  rounds=${run.rounds}  ` +
      `$${run.cost.toFixed(2)}  ${run.seconds}s${run.stuck ? `  stuck=${run.stuck}` : ""}${run.error ? `  (${run.error.slice(0, 80)})` : ""}`,
  );
}

const jobs: (() => Promise<void>)[] = [];
for (const c of cases) for (const p of powers) for (let rep = 1; rep <= Number(a.repeat); rep++) jobs.push(() => one(c, p, rep));
console.log(`${jobs.length} run(s): ${cases.length} case(s) x ${powers.join("/")} x ${a.repeat}, ${a.parallel} at a time`);
console.log(`work dirs: ${workRoot}\nresults:   ${jsonl}\n`);

const workers = Array.from({ length: Math.max(1, Number(a.parallel)) }, async () => {
  for (let job = jobs.shift(); job; job = jobs.shift()) await job();
});
await Promise.all(workers);

// ---------- summary ----------
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const lines: string[] = [];
lines.push(`# Eval ${stamp}`, "");
lines.push(`Cases: ${cases.map((c) => c.id).join(", ")}  `);
lines.push(`Settings: max-rounds ${a["max-rounds"]}, max-cost $${a["max-cost"]}, repeat ${a.repeat}${a["claude-bin"] ? `, claude-bin ${a["claude-bin"]}` : ""}`, "");
lines.push("## By power tier", "");
lines.push("| power | runs | hidden pass | claimed pass | false pass | avg rounds | avg cost | avg time | total cost |");
lines.push("|---|---|---|---|---|---|---|---|---|");
for (const p of powers) {
  const rs = runs.filter((r) => r.power === p);
  lines.push(
    `| ${p} | ${rs.length} | ${pct(rs.filter((r) => r.hidden).length, rs.length)} | ${pct(rs.filter((r) => r.claimed).length, rs.length)} | ` +
      `${rs.filter((r) => r.claimed && !r.hidden).length} | ${avg(rs.map((r) => r.rounds)).toFixed(1)} | $${avg(rs.map((r) => r.cost)).toFixed(2)} | ` +
      `${(avg(rs.map((r) => r.seconds)) / 60).toFixed(1)} min | $${rs.reduce((s, r) => s + r.cost, 0).toFixed(2)} |`,
  );
}
lines.push("", "False pass: orch reported success but the hidden tests failed.", "");
lines.push("## By case", "");
lines.push(`| case | kind | ${powers.join(" | ")} |`);
lines.push(`|---|---|${powers.map(() => "---").join("|")}|`);
for (const c of cases) {
  const cell = (p: string) =>
    runs
      .filter((r) => r.case === c.id && r.power === p)
      .map((r) => `${r.hidden ? "✓" : r.claimed ? "✗ (claimed ✓)" : "✗"} ${r.rounds}r $${r.cost.toFixed(2)}`)
      .join("<br>") || "-";
  lines.push(`| ${c.id} | ${c.kind} | ${powers.map(cell).join(" | ")} |`);
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
