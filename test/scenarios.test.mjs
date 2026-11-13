// End-to-end scenarios for orch.ts with the fake claude: no model calls, no tokens.
// Each test makes a throwaway git repo in the OS temp dir and runs `orch` from source through tsx.
//
//   cd orch-ui && npm test                     (or: node --test ../test/)
//
// Needs `npm install` in orch-ui (for tsx) and git on PATH.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "orch-ui", "node_modules", "tsx", "dist", "cli.mjs");
const ORCH = join(ROOT, "orch.ts");
const FAKE = join(ROOT, "test", "fake-claude", process.platform === "win32" ? "claude.cmd" : "claude");
const KEEP = !!process.env.KEEP_TEST_REPOS; // set to inspect the repos after a failure

if (!existsSync(TSX)) throw new Error(`tsx not found at ${TSX}: run "npm install" in orch-ui first`);

const dirs = [];
process.on("exit", () => {
  if (!KEEP) for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A fresh repo with one empty commit (or a plain directory with { git: false }). */
function repo({ git: useGit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yaaiorch-test-"));
  dirs.push(dir);
  if (useGit) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "user.email", "test@localhost");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  }
  return dir;
}

/** Run `orch <args>` in dir with the fake claude. Returns exit code, output, parsed events and the fake's call log. */
function orch(dir, args, env = {}) {
  const logFile = `${dir}.fake.log`;
  const r = spawnSync(process.execPath, [TSX, ORCH, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CLAUDE_BIN: FAKE, ORCH_EVENTS: "1", FORCE_COLOR: "0", FAKE_LOG: logFile, ...env },
  });
  const out = `${r.stdout}${r.stderr}`;
  const events = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("@@ORCH@@ "))
    .map((l) => JSON.parse(l.slice(9)));
  const calls = existsSync(logFile) ? readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean) : [];
  return {
    code: r.status,
    out,
    events,
    calls,
    ev: (type) => events.filter((e) => e.type === type),
    last: (type) => events.filter((e) => e.type === type).at(-1),
  };
}

/** Start `orch <args>` without waiting; `done` resolves with exit code and output. */
function orchAsync(dir, args, env = {}) {
  const child = spawn(process.execPath, [TSX, ORCH, ...args], {
    cwd: dir,
    env: { ...process.env, CLAUDE_BIN: FAKE, ORCH_EVENTS: "1", FORCE_COLOR: "0", FAKE_LOG: `${dir}.fake.log`, ...env },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise((ok) => child.on("close", (code) => ok({ code, out })));
  return { child, done };
}
const until = async (cond, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
};

const branches = (dir, pattern = "orchestrator/*") => git(dir, "branch", "--list", pattern, "--format=%(refname:short)").split("\n").filter(Boolean);
const dirty = (dir) => git(dir, "status", "--porcelain", "--", ".", ":(exclude).orchestrator");
const lastRun = (dir) => JSON.parse(readFileSync(join(dir, ".orchestrator", "last-run.json"), "utf8"));
const writeConfig = (dir, cfg) => {
  mkdirSync(join(dir, ".orchestrator"), { recursive: true });
  writeFileSync(join(dir, ".orchestrator", "config.json"), JSON.stringify(cfg));
};

// spawnSync blocks, so the scenarios run one after another; the timeout makes a hang fail instead of stalling CI.
describe("orch scenarios (fake claude)", { timeout: 300_000 }, () => {
  test("happy path: roles, permissions, costs, commit, checkpoint removed", () => {
    const dir = repo();
    const r = orch(dir, ["run", "build it", "--max-rounds", "2"], { FAKE_QA: "needs-new" });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.last("goal_end").passed, true);
    assert.equal(r.last("goal_end").cost, 0.25); // architect + 3 implementers + qa
    // QA saw the new (untracked at build time) files through the round commit.
    assert.ok(r.calls.includes("qa: sawNewFiles=true"), r.calls.join("\n"));
    // Read-only roles vs implementers.
    for (const c of r.calls.filter((c) => c.startsWith("call agent="))) {
      const readOnly = /agent=(architect|qa) /.test(c);
      assert.match(
        c,
        readOnly ? /mode=default settings=\.orchestrator\/readonly-settings\.json/ : /mode=acceptEdits settings=\.orchestrator\/agent-settings\.json/,
        c,
      );
    }
    assert.match(git(dir, "log", "--format=%s"), /orch: build it \(round 1\)/);
    assert.deepEqual(branches(dir), [], "checkpoint deleted on pass");
    assert.equal(dirty(dir), "");
    assert.equal(lastRun(dir).status, "passed");
    assert.equal(lastRun(dir).checkpoint, undefined);
  });

  test("commits rounds when .gitignore lists .orchestrator; a committed config stays tracked", () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), ".orchestrator/\n");
    writeConfig(dir, { checks: { ok: 'node -e "process.exit(0)"' } });
    git(dir, "add", "-A");
    git(dir, "add", "-f", ".orchestrator/config.json");
    git(dir, "commit", "-q", "-m", "ignore state, keep config");
    const r = orch(dir, ["run", "build it", "--max-rounds", "1"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /commit failed/);
    assert.match(git(dir, "log", "--format=%s"), /orch: build it \(round 1\)/);
    assert.equal(git(dir, "status", "--porcelain"), "", "nothing left staged or modified");
    assert.match(git(dir, "ls-files", ".orchestrator"), /config\.json/);
    assert.doesNotMatch(git(dir, "ls-files", ".orchestrator"), /last-run|queue/);
  });

  test("a commit hook that rejects every commit: checkpoint kept, rollback still works", () => {
    const dir = repo();
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'rejected by hook' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const r = orch(dir, ["run", "build it", "--max-rounds", "1"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.last("goal_end").passed, true);
    assert.match(r.out, /not fully committed, so orchestrator\/checkpoint-\S+ is kept/);
    const [cp] = branches(dir, "orchestrator/checkpoint-*");
    assert.ok(cp, "checkpoint survives the failed commit");
    assert.equal(lastRun(dir).checkpoint, cp, "the UI's rollback offer stays");
    assert.notEqual(dirty(dir), "", "the work is still there, uncommitted");

    // Rollback parks the work on a side branch without running the hook, then resets.
    const rb = orch(dir, ["rollback"]);
    assert.equal(rb.code, 0, rb.out);
    assert.equal(dirty(dir), "");
    assert.deepEqual(branches(dir, "orchestrator/checkpoint-*"), []);
    const [saved] = branches(dir, "orchestrator/discarded-*");
    assert.match(git(dir, "ls-tree", "-r", "--name-only", saved), /src\/api\.ts/);
  });

  test("works outside git (no checkpoint, no commits)", () => {
    const dir = repo({ git: false });
    const r = orch(dir, ["run", "x", "--max-rounds", "1"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.ev("checkpoint").length, 0);
    assert.match(r.out, /not a git repo/);
  });

  test("refuses a dirty working tree before calling any agent", () => {
    const dir = repo();
    writeFileSync(join(dir, "notes.txt"), "uncommitted");
    const r = orch(dir, ["run", "x"]);
    assert.equal(r.code, 1);
    assert.match(r.last("goal_end").error, /uncommitted changes/);
    assert.equal(r.calls.length, 0);
  });

  test("a rejected plan is sent back once with the reason", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_BAD_PLAN_ONCE: "1" });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes("architect: got rejection reason"));
    assert.match(r.out, /plan rejected/);
  });

  test("a crashing build task fails the round but its sibling finishes", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_FAIL_AGENT: "be" });
    assert.equal(r.code, 1);
    const ends = r.ev("task_end");
    assert.equal(ends.find((e) => e.agent === "be").status, "ERROR");
    assert.equal(ends.find((e) => e.agent === "fe" && e.phase === "build").status, "COMPLETE");
    assert.ok(r.last("round_end").failures.some((f) => /be task failed/.test(f)));
  });

  test("a failed check fails the round even when QA passes", () => {
    const dir = repo();
    writeConfig(dir, { checks: { boom: 'node -e "console.log(42); process.exit(3)"' } });
    const r = orch(dir, ["run", "x", "--max-rounds", "1"]);
    assert.equal(r.code, 1);
    assert.deepEqual(
      r.last("checks").results.map((c) => [c.name, c.ok, c.code]),
      [["boom", false, 3]],
    );
    assert.equal(r.ev("task_end").find((e) => e.agent === "qa").status, "PASS");
    assert.equal(r.last("round_end").passed, false);
    assert.ok(r.last("round_end").failures.some((f) => /check "boom" failed/.test(f)));
  });

  test("agent timeout kills the hung agent and the goal goes on", () => {
    const dir = repo();
    const start = Date.now();
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--agent-timeout", "0.05"], { FAKE_HANG_AGENT: "be" });
    assert.ok(Date.now() - start < 60_000, "returned well before the test timeout");
    assert.equal(r.code, 1);
    const be = r.ev("task_end").find((e) => e.agent === "be");
    assert.equal(be.status, "ERROR");
    assert.match(be.error, /timed out after 3 s/);
  });

  test("parallel build agents share the remaining budget instead of each getting all of it", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--max-cost", "0.30"], { FAKE_QA: "pass", FAKE_SLOW: "1" });
    assert.equal(r.code, 0, r.out);
    const calls = r.calls.filter((c) => c.startsWith("call "));
    const capOf = (c) => [/agent=(\S+)/.exec(c)[1], Number(/ cap=(\S+)$/.exec(c)[1])];
    // architect 0.30 -> foundation fe gets the 0.25 left -> be and fe build in parallel: 0.20 left, 0.10 each -> qa 0.10.
    assert.deepEqual(
      calls.map(capOf),
      [
        ["architect", 0.3],
        ["fe", 0.25],
        ["be", 0.1],
        ["fe", 0.1],
        ["qa", 0.1],
      ],
      calls.join("\n"),
    );
    assert.equal(r.last("goal_end").cost, 0.25);
  });

  test("fix rounds see the previous round; the project brief is written once and reused", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "2"], { FAKE_QA: "fail" });
    assert.equal(r.code, 1, r.out);
    const arch = r.calls.filter((c) => c.startsWith("architect: previousRound"));
    assert.deepEqual(arch, ["architect: previousRound=false brief=asked", "architect: previousRound=true brief=seen"], r.calls.join("\n"));
    assert.match(readFileSync(join(dir, ".orchestrator", "brief.md"), "utf8"), /FAKE BRIEF/);
    assert.equal(dirty(dir), "", "the brief stays out of commits");

    git(dir, "reset", "-q", "--hard", branches(dir, "orchestrator/checkpoint-*")[0] ?? "HEAD");
    const r2 = orch(dir, ["run", "y", "--max-rounds", "1", "--dry-run"]);
    assert.ok(r2.calls.includes("architect: previousRound=false brief=seen"), "the next goal reuses the brief");
    const r3 = orch(dir, ["run", "y", "--max-rounds", "1", "--dry-run", "--no-brief"]);
    assert.ok(r3.calls.includes("architect: previousRound=false brief=none"), "--no-brief leaves it out");
  });

  test("a stuck round with one failing task moves only that agent up a tier", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "3"], { FAKE_FAIL_AGENT: "be", FAKE_QA: "pass" });
    assert.equal(r.code, 1, r.out);
    const stuck = r.ev("stuck");
    assert.equal(stuck[0].action, "escalate");
    assert.deepEqual(stuck[0].agents, { be: "max" }, JSON.stringify(stuck));
    assert.equal(stuck[0].power, "heavy", "the round's tier stays");
    const models = (agent) => r.calls.filter((c) => c.startsWith(`call agent=${agent} `)).map((c) => /model=(\S+)/.exec(c)[1]);
    assert.deepEqual(models("be"), ["sonnet", "sonnet", "opus"], "be: heavy impl, then max impl");
    assert.ok(
      models("fe").every((m) => m === "sonnet"),
      `fe stays: ${models("fe")}`,
    );
    assert.ok(models("architect").every((m) => m === "opus"));
    assert.deepEqual(r.ev("round_start").at(-1).agentPower, { be: "max" });
  });

  test("notes: QA's lessons and round-1 pitfalls are kept and the next goal's architect reads them", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_QA_NOTE: "FAKE LESSON: run the api tests with --runInBand" });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes("architect: notes=none"));
    const notes = readFileSync(join(dir, ".orchestrator", "notes.md"), "utf8");
    assert.match(notes, /passed in 1 round\(s\) · x\n- FAKE LESSON: run the api tests with --runInBand/);
    assert.equal(dirty(dir), "", "notes stay out of commits");

    const failed = orch(dir, ["run", "y", "--max-rounds", "1"], { FAKE_QA: "fail" });
    assert.equal(failed.code, 1);
    assert.ok(failed.calls.includes("architect: notes=seen"), failed.calls.join("\n"));
    assert.match(readFileSync(join(dir, ".orchestrator", "notes.md"), "utf8"), /failed in 1 round\(s\) · y\n- Unresolved: fake failure/);

    git(dir, "reset", "-q", "--hard", branches(dir, "orchestrator/checkpoint-*")[0]);
    const off = orch(dir, ["run", "z", "--dry-run", "--no-notes"]);
    assert.ok(off.calls.includes("architect: notes=none"), "--no-notes leaves them out");
  });

  test("orch learn writes a stamped brief; implementers and QA get it; a stale brief goes back to the architect", () => {
    const dir = repo();
    const l = orch(dir, ["learn", "--power", "economy"]);
    assert.equal(l.code, 0, l.out);
    assert.ok(l.calls.includes("learn: called old=false"));
    assert.ok(
      l.calls.some((c) => /^call agent=architect mode=default .* model=sonnet/.test(c)),
      "read-only, economy architect",
    );
    assert.equal(l.last("learn_end").ok, true);
    assert.equal(l.last("learn_end").cost, 0.05);
    const raw = readFileSync(join(dir, ".orchestrator", "brief.md"), "utf8");
    assert.match(raw, new RegExp(`^<!-- orch: written at commit ${git(dir, "rev-parse", "HEAD")} -->\\n.*FAKE BRIEF learned`, "s"));

    // A goal right after: no refresh, and every agent gets the brief.
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes("architect: previousRound=false brief=seen"));
    assert.ok(!r.calls.includes("architect: brief stale"));
    for (const who of ["fe", "be", "qa"]) assert.ok(r.calls.includes(`${who}: got brief`), `${who}\n${r.calls.join("\n")}`);

    // 20+ files changed since the brief's commit: the architect is asked to check it; it is re-stamped after.
    for (let i = 0; i < 21; i++) writeFileSync(join(dir, `f${i}.txt`), String(i));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "many files");
    const s = orch(dir, ["run", "y", "--max-rounds", "1"], { FAKE_QA: "pass" });
    assert.equal(s.code, 0, s.out);
    assert.ok(s.calls.includes("architect: brief stale"), s.calls.join("\n"));
    assert.match(
      readFileSync(join(dir, ".orchestrator", "brief.md"), "utf8"),
      new RegExp(`commit ${git(dir, "rev-parse", "HEAD~1")}|commit ${git(dir, "rev-parse", "HEAD")}`),
    );
    const again = orch(dir, ["run", "z", "--dry-run"]);
    const staleLines = (x) => x.calls.filter((c) => c === "architect: brief stale").length; // the fake's log spans all runs in dir
    assert.equal(staleLines(again), staleLines(s), "checked once, not every goal");

    // Learning again passes the current brief to correct.
    assert.ok(orch(dir, ["learn"]).calls.includes("learn: called old=true"));
  });

  test("plan critic: a rejected plan goes back to the architect once; off by default", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--critic"], { FAKE_QA: "pass", FAKE_CRITIC: "reject-once" });
    assert.equal(r.code, 0, r.out);
    const critic = r.calls.filter((c) => c.startsWith("critic:"));
    assert.deepEqual(critic, ["critic: rejected sawPlan=true"], "one review per round, not of the revised plan");
    assert.ok(r.calls.includes("architect: got critic issues"));
    assert.equal(r.calls.filter((c) => c.startsWith("call agent=architect")).length, 2);
    assert.ok(
      r.calls.some((c) => /^call agent=critic mode=default settings=\.orchestrator\/readonly-settings\.json model=opus/.test(c)),
      "read-only, QA's model",
    );
    assert.deepEqual(r.last("critic"), { ...r.last("critic"), round: 1, approved: false, issues: ["the plan forgets the tests"], revised: true });
    assert.ok(!r.last("plan").tasks.some((t) => t.agent === "critic"));

    const plain = orch(repo(), ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_CRITIC: "reject" });
    assert.equal(plain.code, 0);
    assert.equal(plain.ev("critic").length, 0);
    assert.ok(!plain.calls.some((c) => c.startsWith("critic:")));
  });

  test("run lock: a second orch in the same repo is refused; a dead holder's lock is taken over", async () => {
    const dir = repo();
    const first = orchAsync(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_SLOW: "2" });
    await until(() => existsSync(join(dir, ".orchestrator", "run.lock")));
    const second = orch(dir, ["run", "y", "--max-rounds", "1"]);
    assert.notEqual(second.code, 0);
    assert.match(second.out, /another orch is already running in this repo \(run, pid \d+/);
    const add = orch(dir, ["add", "queued while running"]);
    assert.equal(add.code, 0, "adding goals is still allowed");
    assert.equal((await first.done).code, 0);
    assert.ok(!existsSync(join(dir, ".orchestrator", "run.lock")), "released on exit");

    // A lock left by a process that no longer exists (killed with taskkill /F, kill -9, a crash).
    const lock = join(dir, ".orchestrator", "run.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999999, host: (await import("node:os")).hostname(), cmd: "loop", since: Date.now(), id: "dead" }));
    const r = orch(dir, ["run", "z", "--max-rounds", "1", "--dry-run"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /taking over a stale lock \(loop, pid 999999\): its process is gone/);
  });

  test("queue: parallel adds all land; a damaged queue file is reported and left alone", async () => {
    const dir = repo();
    const adds = Array.from({ length: 6 }, (_, i) => orchAsync(dir, ["add", `goal ${i}`]));
    for (const a of adds) assert.equal((await a.done).code, 0);
    const q = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.equal(q.length, 6);
    assert.deepEqual(
      q.map((i) => i.id).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
    );
    assert.ok(!existsSync(join(dir, ".orchestrator", "queue.lock")));

    writeFileSync(join(dir, ".orchestrator", "queue.json"), '[{"id": 1, "goal": "half wri');
    const bad = orch(dir, ["add", "another"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /queue\.json is not valid JSON .*Nothing was changed/);
    assert.equal(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"), '[{"id": 1, "goal": "half wri');
    assert.notEqual(orch(dir, ["loop", "--until-empty"]).code, 0, "the loop refuses it too");
  });

  test("plan paths outside the repo, in .git or .orchestrator, or through a link are rejected", () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "yaaiorch-outside-"));
    dirs.push(outside);
    symlinkSync(outside, join(dir, "linked"), "junction");
    const cases = [
      ["../escape.ts", /must not leave the repo/],
      ["src/../../escape.ts", /must not leave the repo/],
      [process.platform === "win32" ? "C:\\Windows\\x.ts" : "/etc/x.ts", /relative to the repo root/],
      [".git/hooks/pre-commit", /inside \.git\//],
      [".orchestrator/queue.json", /inside \.orchestrator\//],
      ["linked/x.ts", /outside the repo \(through a link\)/],
    ];
    for (const [file, why] of cases) {
      const r = orch(dir, ["run", "x", "--max-rounds", "1", "--dry-run"], { FAKE_BE_FILE: file });
      assert.notEqual(r.code, 0, file);
      assert.match(r.out, new RegExp(`task 1 \\(be\\): file "${file.replace(/[\\.?*()[\]]/g, "\\$&")}" .*${why.source}`), r.out);
    }
    assert.ok(!existsSync(join(outside, "x.ts")));
    const ok = orch(dir, ["run", "x", "--max-rounds", "1", "--dry-run"], { FAKE_BE_FILE: "./src/api2.ts" });
    assert.equal(ok.code, 0, ok.out);
  });

  test("stop after this goal: the loop finishes the current goal and leaves the rest pending", async () => {
    const dir = repo();
    orch(dir, ["add", "first"]);
    orch(dir, ["add", "second"]);
    // A stop request left over from an earlier loop is ignored.
    writeFileSync(join(dir, ".orchestrator", "stop-after-goal"), "old");
    const loop = orchAsync(dir, ["loop", "--until-empty", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_SLOW: "1" });
    const queue = () => JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    await until(() => queue()[0].status === "running");
    assert.equal(orch(dir, ["stop-after"]).code, 0);
    const r = await loop.done;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /stop requested: not starting another goal/);
    assert.deepEqual(
      queue().map((i) => i.status),
      ["done", "pending"],
    );
    assert.ok(!existsSync(join(dir, ".orchestrator", "stop-after-goal")), "the request is used up");
    assert.ok(r.out.includes('"type":"loop_stop"'));
  });

  test("a transient API error is retried once; the task then succeeds", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_TRANSIENT_ONCE: "be", ORCH_RETRY_DELAY_MS: "10" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /be: transient error \(be: CLI returned success: API Error: 529/);
    assert.equal(r.calls.filter((c) => c.startsWith("call agent=be ")).length, 2);
    assert.equal(r.ev("task_end").find((e) => e.agent === "be").status, "COMPLETE");
  });

  test("files changed outside every task's list: QA is told; --strict-files fails the round", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_STRAY_FILE: "docs/stray.md" });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.last("unowned").files, ["docs/stray.md"]);
    assert.ok(r.calls.includes("qa: told about files outside the plan"));

    const s = orch(repo(), ["run", "x", "--max-rounds", "1", "--strict-files"], { FAKE_QA: "pass", FAKE_STRAY_FILE: "docs/stray.md" });
    assert.equal(s.code, 1, s.out);
    assert.equal(s.last("round_end").passed, false);
    assert.match(s.last("round_end").failures.join("\n"), /files changed outside every task's file list: docs\/stray\.md/);

    const clean = orch(repo(), ["run", "x", "--max-rounds", "1", "--strict-files"], { FAKE_QA: "pass" });
    assert.equal(clean.code, 0, "owned files only: no complaint");
    assert.equal(clean.ev("unowned").length, 0);
  });

  test("--max-cost-total: the loop stops before the next goal once its budget is spent", () => {
    const dir = repo();
    for (const g of ["one", "two", "three"]) orch(dir, ["add", g]);
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--max-cost-total", "0.4"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    const q = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.deepEqual(
      q.map((i) => i.status),
      ["done", "failed", "pending"],
      r.out,
    );
    assert.equal(r.last("loop_stop").reason, "budget");
    assert.ok(r.last("loop_stop").spent > 0.25, "the second goal's spending counts too");
    assert.match(r.out, /loop budget of \$0\.40 used up/);
    assert.notEqual(orch(dir, ["loop", "--max-cost-total", "0"]).code, 0, "0 is rejected");
  });

  test("phantom completion: a task that claims success without a diff is re-dispatched once", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_NOWRITE: "1" });
    assert.equal(r.calls.filter((c) => c.startsWith("call agent=be ")).length, 2, "be asked twice");
    assert.equal(r.ev("task_end").find((e) => e.agent === "be").status, "PHANTOM");
    assert.match(r.out, /phantom completion by be; re-dispatching/);
  });

  test("a failed foundation task skips the build and verify tasks of the round", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_FAIL_AGENT: "fe" });
    assert.equal(r.code, 1);
    const ends = r.ev("task_end");
    assert.deepEqual(
      ends.map((e) => [e.agent, e.phase, e.status]),
      [
        ["fe", "foundation", "ERROR"],
        ["be", "build", "SKIPPED"],
        ["fe", "build", "SKIPPED"],
        ["qa", "verify", "SKIPPED"],
      ],
    );
    assert.ok(!r.calls.some((c) => c.startsWith("call agent=be ")), "build agents never called");
  });

  test("budget cap stops the goal", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "3", "--max-cost", "0.12"]);
    assert.equal(r.code, 1);
    assert.match(r.last("goal_end").error, /budget of \$0\.12 used up/);
    assert.match(r.out, /Stopped: budget/);
    assert.ok(
      r.calls.some((c) => / cap=0\.12$/.test(c)),
      "remaining budget passed as --max-budget-usd",
    );
  });

  test("stuck rounds move up a tier, then stop the goal", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "5", "--power", "balanced"], { FAKE_QA: "fail", FAKE_NOWRITE: "1" });
    assert.equal(r.code, 1);
    assert.deepEqual(
      r.ev("round_start").map((e) => e.power),
      ["balanced", "heavy"],
    );
    assert.deepEqual(
      r.ev("stuck").map((e) => e.action),
      ["escalate", "stop"],
    );
    assert.ok(r.calls.includes("architect: got stuck note"));
  });

  test("failed run keeps its commits; rollback undoes them and keeps the work on a branch", () => {
    const dir = repo();
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD");

    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "fail" });
    assert.equal(r.code, 1);
    const [cp] = branches(dir, "orchestrator/checkpoint-*");
    assert.ok(cp, "checkpoint kept after a failed run");
    assert.equal(lastRun(dir).checkpoint, cp);
    assert.notEqual(git(dir, "rev-parse", "HEAD"), base);

    writeFileSync(join(dir, "keep.txt"), "base\nstray edit\n"); // like a Stop in the middle of a round
    const rb = orch(dir, ["rollback"]);
    assert.equal(rb.code, 0, rb.out);
    assert.equal(git(dir, "rev-parse", "HEAD"), base);
    assert.equal(dirty(dir), "");
    const [saved] = branches(dir, "orchestrator/discarded-*");
    assert.ok(saved, "discarded work kept");
    assert.match(git(dir, "show", `${saved}:keep.txt`), /stray edit/);
    assert.deepEqual(branches(dir, "orchestrator/checkpoint-*"), []);
    assert.equal(lastRun(dir).checkpoint, undefined);

    const again = orch(dir, ["rollback"]);
    assert.equal(again.code, 1);
    assert.match(again.out, /no orchestrator\/checkpoint-\* branch/);
  });

  test("loop parks failed goals and starts each one from a clean base", () => {
    const dir = repo();
    const base = git(dir, "rev-parse", "HEAD");
    orch(dir, ["add", "goal one"]);
    orch(dir, ["add", "goal two"]);
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "1"], { FAKE_QA: "fail" });
    assert.equal(r.code, 0, r.out);
    assert.match(orch(dir, ["status"]).out, /#1 \[failed\] goal one[\s\S]*#2 \[failed\] goal two/);
    assert.equal(branches(dir, "orchestrator/failed-*").length, 2);
    assert.equal(git(dir, "rev-parse", "HEAD"), base);
    assert.equal(dirty(dir), "");
  });

  test("usage cap with --on-limit stop: the call after a reading over the cap is not made, exit 3", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--usage-cap", "5h=80,week=95", "--on-limit", "stop"], { FAKE_USAGE: "0.9,0.3" });
    assert.equal(r.code, 3, r.out);
    assert.deepEqual({ five: r.last("usage").fiveHour.pct, week: r.last("usage").week.pct }, { five: 90, week: 30 });
    assert.ok(r.last("usage").fiveHour.resetsAt > Date.now());
    assert.equal(r.calls.filter((c) => c.startsWith("call ")).length, 1, "only the architect ran");
    assert.match(r.last("goal_end").error, /5-hour usage at 90% \(cap 80%\)/);
    assert.equal(r.last("goal_end").usageLimit, true);
  });

  test("usage cap with wait: pauses before each call in place and the goal still passes", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--usage-cap", "week=25"], { FAKE_USAGE: "0.1,0.3", FAKE_QA: "pass", ORCH_LIMIT_WAIT_MS: "300" });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.last("goal_end").passed, true);
    const waits = r.ev("waiting").filter((e) => e.reason === "usage_cap");
    assert.ok(waits.length >= 1 && waits.every((e) => e.window === "week"), JSON.stringify(waits));
    assert.deepEqual(branches(dir, "orchestrator/interrupted-*"), [], "nothing set aside");
  });

  test("bad --usage-cap is rejected", () => {
    const dir = repo();
    for (const spec of ["5h=0", "5h=101", "day=50", "5h"]) {
      const r = orch(dir, ["run", "x", "--usage-cap", spec]);
      assert.notEqual(r.code, 0, spec);
      assert.match(r.out, /usage-cap/, spec);
    }
  });

  test("plugins: list with token cost; off, disable and no-hooks reach the agents' settings", () => {
    const dir = repo();
    const list = orch(dir, ["plugins", "--json", "--details"]);
    assert.equal(list.code, 0, list.out);
    const plugins = JSON.parse(list.out.split(/\r?\n/).find((l) => l.startsWith("[")));
    assert.deepEqual(
      plugins.map((p) => [p.id, p.enabled, p.tokens]),
      [
        ["caveman@caveman", true, 1234],
        ["superpowers@claude-plugins-official", true, 1234],
        ["old@market", false, 1234],
      ],
    );
    const settings = (file) => JSON.parse(readFileSync(join(dir, ".orchestrator", file), "utf8"));

    let r = orch(dir, ["run", "x", "--max-rounds", "1", "--dry-run"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(settings("agent-settings.json").enabledPlugins, undefined, "default: plugins untouched");
    assert.equal(settings("agent-settings.json").disableAllHooks, undefined);

    r = orch(dir, ["run", "x", "--dry-run", "--plugins", "off", "--no-hooks"]);
    assert.equal(r.code, 0, r.out);
    for (const f of ["agent-settings.json", "readonly-settings.json"]) {
      assert.deepEqual(settings(f).enabledPlugins, { "caveman@caveman": false, "superpowers@claude-plugins-official": false }, f);
      assert.equal(settings(f).disableAllHooks, true, f);
    }
    assert.ok(settings("readonly-settings.json").permissions.deny.includes("Edit"), "read-only deny kept");
    assert.deepEqual(r.last("goal_start").plugins, { off: true, disable: [], hooks: false });

    writeConfig(dir, { plugins: { disable: ["caveman@caveman"] } });
    r = orch(dir, ["run", "x", "--dry-run", "--disable-plugins", "superpowers@claude-plugins-official"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(settings("agent-settings.json").enabledPlugins, { "caveman@caveman": false, "superpowers@claude-plugins-official": false });
    assert.equal(settings("agent-settings.json").disableAllHooks, undefined);

    for (const bad of [
      ["--plugins", "maybe"],
      ["--disable-plugins", "a b;rm"],
    ]) {
      const b = orch(dir, ["run", "x", "--dry-run", ...bad]);
      assert.notEqual(b.code, 0, bad.join(" "));
    }
  });

  test("usage limit in run with --on-limit stop: exit 3, no stuck round, reset time reported", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "3", "--on-limit", "stop"], { FAKE_LIMIT_AFTER: "2" });
    assert.equal(r.code, 3, r.out);
    const lim = r.last("usage_limit");
    assert.ok(lim, "usage_limit event");
    assert.equal(typeof lim.resetAt, "number");
    assert.ok(lim.resetAt > Date.now() && lim.resetAt <= Date.now() + 86_400_000);
    assert.equal(r.last("goal_end").usageLimit, true);
    assert.equal(r.ev("stuck").length, 0);
    assert.equal(r.ev("round_start").length, 1);
  });

  test("usage limit in loop: goal requeued, waited, retried, and the queue finishes", () => {
    const dir = repo();
    orch(dir, ["add", "goal one"]);
    orch(dir, ["add", "goal two"]);
    // Only the 3rd claude call hits the limit (goal one's first build task).
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "2"], { FAKE_LIMIT_ON: "3", ORCH_LIMIT_WAIT_MS: "2000" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /usage limit reached; goal #1 is pending again/);
    assert.equal(r.ev("waiting").length, 1);
    assert.match(orch(dir, ["status"]).out, /#1 \[done\] goal one[\s\S]*#2 \[done\] goal two/);
    assert.equal(branches(dir, "orchestrator/interrupted-*").length, 1);
    const queue = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.ok(
      queue.every((i) => !i.note),
      "waiting note cleared",
    );
  });

  test("fast path: one dev call, judged by the checks, no architect or QA", () => {
    const dir = repo();
    writeConfig(dir, { checks: { ok: 'node -e "process.exit(0)"' } });
    const r = orch(dir, ["run", "x", "--fast", "--max-rounds", "2"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.calls.filter((c) => c.startsWith("call ")).map((c) => /agent=(\S+)/.exec(c)[1]),
      ["dev"],
    );
    assert.equal(r.ev("round_start")[0].mode, "direct");
    assert.equal(r.ev("architect_start").length, 0);
    assert.equal(r.last("goal_end").cost, 0.05);
    assert.match(
      r.calls.find((c) => c.startsWith("call agent=dev")),
      /mode=acceptEdits/,
    );
    assert.ok(existsSync(join(dir, "src", "direct.txt")));
  });

  test("fast path falls back to the full loop when the direct attempt fails its checks", () => {
    const dir = repo();
    // Passes only once the full loop's plan has written src/api.ts.
    writeConfig(dir, { checks: { api: "node -e \"process.exit(require('fs').existsSync('src/api.ts') ? 0 : 1)\"" } });
    const r = orch(dir, ["run", "x", "--fast", "--max-rounds", "3"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ev("round_start").map((e) => e.mode ?? "full"),
      ["direct", "full"],
    );
    assert.equal(r.ev("round_end")[0].passed, false);
    assert.ok(r.ev("round_end")[0].failures.some((f) => /check "api" failed/.test(f)));
    const agents = r.calls.filter((c) => c.startsWith("call ")).map((c) => /agent=(\S+)/.exec(c)[1]);
    assert.deepEqual(agents, ["dev", "architect", "fe", "be", "fe", "qa"]);
  });

  test("fast path without checks still runs QA", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--fast", "--max-rounds", "1"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.calls.filter((c) => c.startsWith("call ")).map((c) => /agent=(\S+)/.exec(c)[1]),
      ["dev", "qa"],
    );
  });

  test("usage limit in run (default wait): work set aside, waits, retries and passes", () => {
    const dir = repo();
    const base = git(dir, "rev-parse", "HEAD");
    // The 3rd call (a build task, after the foundation task wrote a file) hits the limit.
    const r = orch(dir, ["run", "x", "--max-rounds", "2"], { FAKE_LIMIT_ON: "3", ORCH_LIMIT_WAIT_MS: "1500" });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.ev("waiting").length, 1);
    assert.equal(r.ev("goal_start").length, 2, "the goal is retried after the wait");
    assert.equal(r.last("goal_end").passed, true);
    assert.equal(branches(dir, "orchestrator/interrupted-*").length, 1, "the first attempt's work is kept aside");
    assert.notEqual(git(dir, "rev-parse", "HEAD"), base);
    assert.equal(dirty(dir), "");
  });

  test("usage limit in loop with --on-limit stop: goal left pending, exit 3", () => {
    const dir = repo();
    orch(dir, ["add", "goal one"]);
    orch(dir, ["add", "goal two"]);
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "2", "--on-limit", "stop"], { FAKE_LIMIT_ON: "3" });
    assert.equal(r.code, 3, r.out);
    assert.equal(r.ev("waiting").length, 0);
    const queue = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.deepEqual(
      queue.map((i) => i.status),
      ["pending", "pending"],
    );
    assert.match(queue[0].note, /usage limit: stopped/);
    assert.equal(branches(dir, "orchestrator/interrupted-*").length, 1);
    assert.equal(dirty(dir), "");
  });

  test("onLimit in config.json works like the flag", () => {
    const dir = repo();
    writeConfig(dir, { onLimit: "stop" });
    const r = orch(dir, ["run", "x", "--max-rounds", "2"], { FAKE_LIMIT_ON: "2" });
    assert.equal(r.code, 3, r.out);
    assert.equal(r.ev("waiting").length, 0);
  });

  test("models: role and agent overrides on top of the tier", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--power", "economy", "--model", "architect=opus,qa=haiku,be=claude-test-1"]);
    assert.equal(r.code, 0, r.out);
    const model = (agent) => /model=(\S+)/.exec(r.calls.find((c) => c.startsWith(`call agent=${agent} `)))[1];
    assert.equal(model("architect"), "opus");
    assert.equal(model("fe"), "haiku", "impl from the economy tier");
    assert.equal(model("be"), "claude-test-1", "agent override");
    assert.equal(model("qa"), "haiku");
    assert.deepEqual(r.ev("round_start")[0].models, { architect: "opus", impl: "haiku", heavy: "sonnet", qa: "haiku", dev: "sonnet" });
    assert.deepEqual(r.ev("goal_start")[0].models, { roles: { architect: "opus", qa: "haiku" }, agents: { be: "claude-test-1" } });
  });

  test("models: config.json, CLI on top, agent beats role", () => {
    const dir = repo();
    writeConfig(dir, { models: { impl: "sonnet", agents: { fe: "opus" } } });
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--power", "economy", "--model", "impl=haiku"]);
    assert.equal(r.code, 0, r.out);
    const models = r.calls.filter((c) => /agent=(fe|be) /.test(c)).map((c) => `${/agent=(\S+)/.exec(c)[1]}=${/model=(\S+)/.exec(c)[1]}`);
    assert.deepEqual(models, ["fe=opus", "be=haiku", "fe=opus"]);
  });

  test("models: aliases step up on escalation, full IDs stay pinned", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "5", "--power", "economy", "--model", "impl=haiku,be=claude-pinned-1"], {
      FAKE_QA: "fail",
      FAKE_NOWRITE: "1",
    });
    assert.equal(r.code, 1);
    const rounds = r.ev("round_start");
    assert.deepEqual(
      rounds.map((e) => e.power),
      ["economy", "balanced"],
    );
    assert.equal(rounds[0].models.impl, "haiku");
    assert.equal(rounds[1].models.impl, "sonnet", "alias moved up with the tier");
    const beModels = r.calls.filter((c) => c.startsWith("call agent=be ")).map((c) => /model=(\S+)/.exec(c)[1]);
    assert.ok(beModels.length >= 2 && beModels.every((m) => m === "claude-pinned-1"), beModels.join(","));
  });

  test("models and on-limit: bad values are rejected", () => {
    const dir = repo();
    for (const [args, message] of [
      [["--model", "architect="], /expected key=model/],
      [["--model", "qa=bad name"], /invalid model name/],
      [["--model", "nobody=opus"], /model override for unknown agent "nobody"/],
      [["--on-limit", "maybe"], /--on-limit must be wait or stop/],
    ]) {
      const r = orch(dir, ["run", "x", "--max-rounds", "1", ...args]);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.out, message);
    }
  });

  test("prune deletes only old orchestrator branches", () => {
    const dir = repo();
    const old = Date.now() - 20 * 86_400_000;
    const recent = Date.now();
    for (const b of [`orchestrator/failed-${old}`, `orchestrator/discarded-${old}`, `orchestrator/failed-${recent}`, "feature/mine"]) git(dir, "branch", b);
    const r = orch(dir, ["prune"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(branches(dir), [`orchestrator/failed-${recent}`]);
    assert.deepEqual(branches(dir, "feature/*"), ["feature/mine"]);
  });

  test("doctor: clean repo passes, dirty repo fails", () => {
    const dir = repo();
    const ok = orch(dir, ["doctor", "--json"]);
    assert.equal(ok.code, 0, ok.out);
    const findings = JSON.parse(ok.out.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(Object.fromEntries(findings.map((f) => [f.name, f.level])), {
      node: "ok",
      claude: "ok",
      "claude login": "ok",
      repo: "ok",
      checks: "warn",
    });
    writeFileSync(join(dir, "x.txt"), "x");
    const bad = orch(dir, ["doctor"]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /FAIL\s+repo: uncommitted changes/);
  });

  test("claude in a folder with spaces, & and % starts and runs a goal (no cmd.exe on Windows)", () => {
    const dir = repo();
    const bin = mkdtempSync(join(tmpdir(), "yaaiorch odd & %PATH% "));
    dirs.push(bin);
    for (const f of ["claude", "claude.cmd", "fake-claude.mjs"]) writeFileSync(join(bin, f), readFileSync(join(dirname(FAKE), f)));
    if (process.platform !== "win32") chmodSync(join(bin, "claude"), 0o755);
    const claudeBin = join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
    const doc = orch(dir, ["doctor", "--json"], { CLAUDE_BIN: claudeBin });
    const findings = JSON.parse(doc.out.trim().split(/\r?\n/).at(-1));
    const claude = findings.find((f) => f.name === "claude");
    assert.equal(claude.level, "ok", doc.out);
    assert.doesNotMatch(claude.detail, /cmd\.exe/);
    const r = orch(dir, ["run", "add a feature"], { CLAUDE_BIN: claudeBin });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.last("goal_end").passed, true);
  });

  test("rejects bad input", () => {
    const dir = repo();
    for (const [args, message] of [
      [["run", "x", "--max-rounds", "0"], /--max-rounds must be a whole number/],
      [["run", "x", "--power", "ultra"], /--power must be one of/],
      [["run", "x", "--max-cost", "0"], /--max-cost must be a positive amount/],
      [["run", "x", "--agent-timeout", "0"], /--agent-timeout must be a positive number/],
      [["loop", "--dry-run"], /--dry-run cannot be used with loop/],
      [["run"], /usage: orch run/],
    ]) {
      const r = orch(dir, args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.out, message);
    }
    assert.match(orch(dir, []).out, /YAAIORCH \(Yet Another AI Orchestrator\) CLI/);
  });
});
