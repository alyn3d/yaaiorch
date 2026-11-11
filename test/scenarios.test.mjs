// End-to-end scenarios for orch.ts with the fake claude: no model calls, no tokens.
// Each test makes a throwaway git repo in the OS temp dir and runs `orch` from source through tsx.
//
//   cd orch-ui && npm test                     (or: node --test ../test/)
//
// Needs `npm install` in orch-ui (for tsx) and git on PATH.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
      assert.match(c, readOnly ? /mode=default settings=\.orchestrator\/readonly-settings\.json/ : /mode=acceptEdits settings=\.orchestrator\/agent-settings\.json/, c);
    }
    assert.match(git(dir, "log", "--format=%s"), /orch: build it \(round 1\)/);
    assert.deepEqual(branches(dir), [], "checkpoint deleted on pass");
    assert.equal(dirty(dir), "");
    assert.equal(lastRun(dir).status, "passed");
    assert.equal(lastRun(dir).checkpoint, undefined);
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
    assert.deepEqual(r.last("checks").results.map((c) => [c.name, c.ok, c.code]), [["boom", false, 3]]);
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

  test("budget cap stops the goal", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "3", "--max-cost", "0.12"]);
    assert.equal(r.code, 1);
    assert.match(r.last("goal_end").error, /budget of \$0\.12 used up/);
    assert.match(r.out, /Stopped: budget/);
    assert.ok(r.calls.some((c) => / cap=0\.12$/.test(c)), "remaining budget passed as --max-budget-usd");
  });

  test("stuck rounds move up a tier, then stop the goal", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "5", "--power", "balanced"], { FAKE_QA: "fail", FAKE_NOWRITE: "1" });
    assert.equal(r.code, 1);
    assert.deepEqual(r.ev("round_start").map((e) => e.power), ["balanced", "heavy"]);
    assert.deepEqual(r.ev("stuck").map((e) => e.action), ["escalate", "stop"]);
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

  test("usage limit in run: exit 3, no stuck round, reset time reported", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "3"], { FAKE_LIMIT_AFTER: "2" });
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
    assert.ok(queue.every((i) => !i.note), "waiting note cleared");
  });

  test("fast path: one dev call, judged by the checks, no architect or QA", () => {
    const dir = repo();
    writeConfig(dir, { checks: { ok: 'node -e "process.exit(0)"' } });
    const r = orch(dir, ["run", "x", "--fast", "--max-rounds", "2"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls.filter((c) => c.startsWith("call ")).map((c) => /agent=(\S+)/.exec(c)[1]), ["dev"]);
    assert.equal(r.ev("round_start")[0].mode, "direct");
    assert.equal(r.ev("architect_start").length, 0);
    assert.equal(r.last("goal_end").cost, 0.05);
    assert.match(r.calls.find((c) => c.startsWith("call agent=dev")), /mode=acceptEdits/);
    assert.ok(existsSync(join(dir, "src", "direct.txt")));
  });

  test("fast path falls back to the full loop when the direct attempt fails its checks", () => {
    const dir = repo();
    // Passes only once the full loop's plan has written src/api.ts.
    writeConfig(dir, { checks: { api: "node -e \"process.exit(require('fs').existsSync('src/api.ts') ? 0 : 1)\"" } });
    const r = orch(dir, ["run", "x", "--fast", "--max-rounds", "3"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.ev("round_start").map((e) => e.mode ?? "full"), ["direct", "full"]);
    assert.equal(r.ev("round_end")[0].passed, false);
    assert.ok(r.ev("round_end")[0].failures.some((f) => /check "api" failed/.test(f)));
    const agents = r.calls.filter((c) => c.startsWith("call ")).map((c) => /agent=(\S+)/.exec(c)[1]);
    assert.deepEqual(agents, ["dev", "architect", "fe", "be", "fe", "qa"]);
  });

  test("fast path without checks still runs QA", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--fast", "--max-rounds", "1"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls.filter((c) => c.startsWith("call ")).map((c) => /agent=(\S+)/.exec(c)[1]), ["dev", "qa"]);
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
    assert.deepEqual(
      Object.fromEntries(findings.map((f) => [f.name, f.level])),
      { node: "ok", claude: "ok", "claude login": "ok", repo: "ok", checks: "warn" },
    );
    writeFileSync(join(dir, "x.txt"), "x");
    const bad = orch(dir, ["doctor"]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /FAIL\s+repo: uncommitted changes/);
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
