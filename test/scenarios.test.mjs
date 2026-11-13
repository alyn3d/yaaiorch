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

  test("diff critic and review lens: both read the change next to QA; a rejection fails the round", () => {
    const dir = repo();
    const ok = orch(dir, ["run", "x", "--max-rounds", "1", "--diff-critic", "--review"], { FAKE_QA: "pass" });
    assert.equal(ok.code, 0, ok.out);
    assert.deepEqual(ok.calls.filter((c) => c.startsWith("review:")).sort(), [
      "review: agent=critic lens=goal patch=true approved",
      "review: agent=reviewer lens=bugs patch=true approved",
    ]);
    assert.deepEqual(
      ok
        .ev("review")
        .map((e) => [e.agent, e.lens, e.approved, e.cost])
        .sort(),
      [
        ["critic", "goal", true, 0.05],
        ["reviewer", "bugs", true, 0.05],
      ],
    );
    assert.equal(ok.last("goal_end").cost, 0.35, "architect + 3 implementers + qa + 2 reviews");
    // Off by default.
    assert.ok(!orch(repo(), ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass" }).calls.some((c) => c.startsWith("review:")));

    const bad = orch(repo(), ["run", "x", "--max-rounds", "1", "--review"], { FAKE_QA: "pass", FAKE_REVIEW_REJECT: "reviewer" });
    assert.equal(bad.code, 1);
    assert.deepEqual(bad.last("round_end").failures, ["reviewer (review): reviewer found a bug in src/api.ts"]);
  });

  test("review lens: your own reviewer agents; unknown names refused; skipped when the checks already failed", () => {
    const dir = repo();
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "sec.md"), "---\nname: sec\ndescription: security reviewer\n---\nReview for security.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "agent");
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--reviewers", "sec"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.calls.filter((c) => c.startsWith("review:")),
      ["review: agent=sec lens=bugs patch=true approved"],
    );
    const unknown = orch(dir, ["run", "x", "--review", "--reviewers", "nobody"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /reviewer "nobody" is not an agent/);

    const failing = repo();
    writeConfig(failing, { checks: { boom: 'node -e "process.exit(3)"' } });
    const f = orch(failing, ["run", "x", "--max-rounds", "1", "--diff-critic", "--review"], { FAKE_QA: "pass" });
    assert.equal(f.code, 1);
    assert.ok(!f.calls.some((c) => c.startsWith("review:")), "a failed check wins; no review is paid for");
  });

  test("notes past the size limit are tidied by one cheap call; a bad reply keeps them", () => {
    const dir = repo();
    const big =
      "# Notes from earlier goals\n\n" +
      Array.from({ length: 80 }, (_, i) => `## 2026-01-01 · passed · g${i}\n- FAKE LESSON ${i}: use the helper\n`).join("\n");
    mkdirSync(join(dir, ".orchestrator"), { recursive: true });
    writeFileSync(join(dir, ".orchestrator", "notes.md"), big);
    const r = orch(dir, ["run", "x", "--max-rounds", "1", "--power", "economy"], { FAKE_QA: "pass", FAKE_QA_NOTE: "new lesson" });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes("tidy: called sawLessons=true"));
    assert.ok(
      r.calls.some((c) => /^call agent=architect mode=default .* model=haiku/.test(c)),
      "read-only, the implementers' model",
    );
    const notes = readFileSync(join(dir, ".orchestrator", "notes.md"), "utf8");
    assert.match(notes, /^# Notes from earlier goals\n\n## \d{4}-\d\d-\d\d · tidied\n- FAKE TIDIED/);
    assert.equal(r.last("notes_tidy").ok, true);
    assert.equal(r.last("goal_end").cost, 0.3, "the tidy call is part of the goal's cost");
    // Short notes: no call.
    assert.ok(!orch(repo(), ["run", "y", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_QA_NOTE: "n" }).calls.some((c) => c.startsWith("tidy:")));

    const kept = repo();
    mkdirSync(join(kept, ".orchestrator"), { recursive: true });
    writeFileSync(join(kept, ".orchestrator", "notes.md"), big);
    const b = orch(kept, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_QA_NOTE: "new lesson", FAKE_TIDY: "bad" });
    assert.equal(b.code, 0, b.out);
    assert.equal(b.last("notes_tidy").ok, false);
    assert.match(readFileSync(join(kept, ".orchestrator", "notes.md"), "utf8"), /FAKE LESSON 79[\s\S]*- new lesson/);
  });

  test("orch share proposes a CLAUDE.md section on a side branch; the working tree is untouched", () => {
    const dir = repo();
    assert.match(orch(dir, ["share"]).out, /nothing learned yet/);
    writeFileSync(join(dir, "CLAUDE.md"), "# My project\n\nHand-written rules.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "claude.md");
    assert.equal(orch(dir, ["learn"]).code, 0);
    const head = git(dir, "rev-parse", "HEAD");

    const dry = orch(dir, ["share", "--dry-run"]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /<!-- yaaiorch:learned:start -->\n## Learned by YAAIORCH\n\nFAKE SECTION/);
    assert.deepEqual(branches(dir), []);

    const r = orch(dir, ["share"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes("share: called brief=true earlier=false"));
    const [branch] = branches(dir);
    assert.match(branch, /^orchestrator\/claude-md-\d+$/);
    assert.equal(r.last("share_end").branch, branch);
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "HEAD unchanged");
    assert.equal(dirty(dir), "", "working tree unchanged");
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "# My project\n\nHand-written rules.\n");
    const proposed = git(dir, "show", `${branch}:CLAUDE.md`);
    assert.match(
      proposed,
      /^# My project\n\nHand-written rules\.\n\n<!-- yaaiorch:learned:start -->\n## Learned by YAAIORCH\n\nFAKE SECTION.*\n<!-- yaaiorch:learned:end -->$/s,
    );

    // After merging, sharing again replaces the section instead of adding a second one.
    git(dir, "merge", "-q", "--ff-only", branch);
    git(dir, "branch", "-D", branch);
    const again = orch(dir, ["share"]);
    assert.ok(again.calls.includes("share: called brief=true earlier=true"));
    const next = git(dir, "show", `${branches(dir)[0]}:CLAUDE.md`);
    assert.equal(next.split("yaaiorch:learned:start").length, 2, "one section");
    assert.match(next, /^# My project\n\nHand-written rules\./);
  });

  test("--branch: the goal runs on its own branch; the starting branch never changes", () => {
    const dir = repo();
    const main = git(dir, "rev-parse", "main");
    const r = orch(dir, ["run", "Add a CSV export!", "--max-rounds", "1", "--branch"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    const gb = r.last("goal_branch");
    assert.match(gb.branch, /^orch\/[0-9a-z]+-add-a-csv-export$/);
    assert.equal(gb.base, "main");
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main", "back on main");
    assert.equal(git(dir, "rev-parse", "main"), main, "main unchanged");
    assert.match(git(dir, "log", "--format=%s", gb.branch), /orch: Add a CSV export! \(round 1\)/);
    assert.deepEqual(branches(dir), [], "no checkpoint left");
    assert.equal(lastRun(dir).branch, gb.branch);
    assert.equal(lastRun(dir).checkpoint, undefined);

    // A failed goal keeps its work on its branch too; main is still untouched.
    const f = orch(dir, ["run", "x", "--max-rounds", "1", "--branch"], { FAKE_QA: "fail" });
    assert.equal(f.code, 1);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(dir, "rev-parse", "main"), main);
    assert.match(git(dir, "log", "--format=%s", f.last("goal_branch").branch), /orch: x \(round 1\)/);

    // A detached HEAD has no branch to come back to.
    git(dir, "checkout", "-q", "--detach");
    assert.match(orch(dir, ["run", "x", "--branch"]).out, /--branch needs a checked-out branch/);
  });

  test("--branch in a loop: each goal branches from the starting branch, not from the goal before", () => {
    const dir = repo();
    orch(dir, ["add", "first goal"]);
    orch(dir, ["add", "second goal"]);
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--branch"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ev("goal_branch").map((e) => e.branch),
      ["orch/1-first-goal", "orch/2-second-goal"],
    );
    assert.equal(git(dir, "rev-parse", "orch/2-second-goal~1"), git(dir, "rev-parse", "main"));
  });

  test("--pr: a passed goal's branch is pushed and a pull request opened with gh; problems are reported, not fatal", () => {
    const FAKE_GH = join(ROOT, "test", "fake-gh", process.platform === "win32" ? "gh.cmd" : "gh");
    const dir = repo();
    const origin = mkdtempSync(join(tmpdir(), "yaaiorch-origin-"));
    dirs.push(origin);
    git(origin, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", origin);
    const ghLog = `${dir}.gh.log`;
    const r = orch(dir, ["run", "Add a CSV export", "--max-rounds", "1", "--pr"], { FAKE_QA: "pass", GH_BIN: FAKE_GH, FAKE_GH_LOG: ghLog });
    assert.equal(r.code, 0, r.out);
    const { branch } = r.last("goal_branch");
    assert.match(git(origin, "branch", "--list", branch), new RegExp(branch.replace(/[/-]/g, "\\$&")), "pushed");
    const [call] = readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(call.args, ["pr", "create", "--base", "main", "--head", branch, "--title", "Add a CSV export", "--body-file", "-"]);
    assert.match(call.body, /^Add a CSV export\n\n## What YAAIORCH did\n- Round 1: fake plan \(passed; \$0\.25\)/);
    assert.equal(r.last("pr").url, `https://github.com/example/repo/pull/${branch.length}`);
    assert.equal(lastRun(dir).pr, r.last("pr").url);

    // gh missing or failing: the branch is still pushed and the goal still passes.
    const noGh = orch(dir, ["run", "y", "--max-rounds", "1", "--pr"], { FAKE_QA: "pass", GH_BIN: join(dir, "no-such-gh") });
    assert.equal(noGh.code, 0, noGh.out);
    assert.match(noGh.last("pr").error, /gh \(GitHub CLI\) was not found/);
    const ghFails = orch(dir, ["run", "z", "--max-rounds", "1", "--pr"], { FAKE_QA: "pass", GH_BIN: FAKE_GH, FAKE_GH_FAIL: "1" });
    assert.equal(ghFails.code, 0);
    assert.match(ghFails.last("pr").error, /gh auth login/);
    // No origin: nothing pushed, reported.
    git(dir, "remote", "remove", "origin");
    assert.match(orch(dir, ["run", "w", "--max-rounds", "1", "--pr"], { FAKE_QA: "pass", GH_BIN: FAKE_GH }).last("pr").error, /no "origin" remote/);
  });

  test("--approve-plan: the run waits; a rejection goes back to the architect; an edited plan is built", async () => {
    const dir = repo();
    const pending = join(dir, ".orchestrator", "plan-pending.json");
    const run = orchAsync(dir, ["run", "x", "--max-rounds", "1", "--approve-plan"], { FAKE_QA: "pass" });
    await until(() => existsSync(pending));
    assert.equal(JSON.parse(readFileSync(pending, "utf8")).round, 1);
    assert.ok(!readFileSync(`${dir}.fake.log`, "utf8").includes("call agent=fe"), "nothing is built while waiting");

    // Send it back with a reason: the architect plans again, and the run waits again.
    const rej = orch(dir, ["approve", "--reject", "split the api task"]);
    assert.equal(rej.code, 0, rej.out);
    await until(() => readFileSync(`${dir}.fake.log`, "utf8").includes("architect: got human rejection: split the api task"));
    await until(() => existsSync(pending) && !existsSync(join(dir, ".orchestrator", "plan-decision.json")));

    // An invalid edit is refused by `orch approve` itself.
    const plan = JSON.parse(readFileSync(pending, "utf8")).plan;
    const stdin = (p) =>
      spawnSync(process.execPath, [TSX, ORCH, "approve", "--plan-stdin"], {
        cwd: dir,
        input: JSON.stringify(p),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_BIN: FAKE },
      });
    const bad = stdin({ ...plan, tasks: [{ agent: "nobody", phase: "build", task: "t", files: ["a"] }, ...plan.tasks] });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr + bad.stdout, /nobody/);

    // Approve an edited plan: only the be task and QA.
    const edited = { ...plan, tasks: plan.tasks.filter((t) => t.agent === "be" || t.agent === "qa") };
    assert.equal(stdin(edited).status, 0);
    const { code, out } = await run.done;
    assert.equal(code, 0, out);
    const events = out
      .split(/\r?\n/)
      .filter((l) => l.startsWith("@@ORCH@@ "))
      .map((l) => JSON.parse(l.slice(9)));
    assert.deepEqual(
      events.filter((e) => e.type === "approval").map((e) => [e.action, e.edited]),
      [
        ["reject", false],
        ["approve", true],
      ],
    );
    assert.equal(events.filter((e) => e.type === "approval_wait").length, 2);
    assert.deepEqual(
      events.find((e) => e.type === "plan").tasks.map((t) => t.agent),
      ["be", "qa"],
    );
    assert.ok(!existsSync(pending), "the pending plan is removed");
    assert.match(orch(dir, ["approve"]).out, /no plan is waiting/);
  });

  test("greenfield: checks are read again after the build, so a package.json written this round is checked", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_BE_FILE: "package.json" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /checks: none configured/);
    assert.deepEqual(
      r.last("checks").results.map((c) => [c.name, c.ok]),
      [["test", true]],
    );
  });

  test("setup: orch installs when a manifest changes, never twice for the same one; its folders stay out of git", () => {
    const dir = repo();
    writeConfig(dir, { setup: "node -e \"require('fs').mkdirSync('deps',{recursive:true});require('fs').writeFileSync('deps/x','1')\"" });
    const r = orch(dir, ["run", "x", "--max-rounds", "2"], { FAKE_QA: "fail-once", FAKE_BE_FILE: "package.json" });
    assert.equal(r.code, 0, r.out);
    const names = (round) =>
      r
        .ev("checks")
        .find((e) => e.round === round)
        .results.map((c) => c.name);
    assert.deepEqual(names(1), ["setup", "test"]);
    assert.deepEqual(names(2), ["test"], "package.json unchanged: no second install");
    assert.ok(r.calls.includes("be: told about setup"), "implementers are told not to install");
    assert.equal(git(dir, "ls-files", "deps"), "", "never committed");
    assert.equal(dirty(dir), "");
    assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /^\/deps\/$/m);

    // A failed setup fails the round, and the checks are not run on a broken install.
    const bad = repo();
    writeConfig(bad, { setup: 'node -e "process.exit(4)"' });
    const b = orch(bad, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_BE_FILE: "package.json" });
    assert.equal(b.code, 1);
    assert.deepEqual(
      b.last("checks").results.map((c) => [c.name, c.ok, c.code]),
      [["setup", false, 4]],
    );
    assert.match(b.last("round_end").failures[0], /check "setup" failed/);
  });

  test("orch new: a repo with SPEC.md, the spec kept for the architects, goals queued, checks suggested; then the loop builds it", () => {
    const parent = repo({ git: false });
    assert.match(orch(parent, ["new", "app"]).out, /usage: orch new DIR/);
    const r = orch(parent, ["new", "app", "A todo CLI in Node", "--setup", "node -e 0"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes("split: fresh=true brief=A todo CLI in Node setup=true"), r.calls.join("\n"));
    const app = join(parent, "app");
    assert.equal(git(app, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.deepEqual(git(app, "ls-files").split("\n").sort(), [".gitignore", "SPEC.md"]);
    assert.match(readFileSync(join(app, ".orchestrator", "brief.md"), "utf8"), /new project/);
    assert.equal(readFileSync(join(app, ".orchestrator", "spec.md"), "utf8"), "A todo CLI in Node\n");
    assert.deepEqual(JSON.parse(readFileSync(join(app, ".orchestrator", "config.json"), "utf8")), {
      checks: { test: 'node -e "process.exit(0)"' },
      setup: "node -e 0",
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(app, ".orchestrator", "queue.json"), "utf8")).map((i) => [i.id, i.goal, i.status]),
      [
        [1, "Set up the project", "pending"],
        [2, "Add the first feature", "pending"],
      ],
    );
    assert.match(orch(parent, ["new", "app", "again"]).out, /is not empty/);

    const loop = orch(app, ["loop", "--until-empty", "--max-rounds", "1"], { FAKE_QA: "pass" });
    assert.equal(loop.code, 0, loop.out);
    assert.deepEqual(
      loop.ev("goal_end").map((e) => e.passed),
      [true, true],
    );
    assert.ok(loop.ev("checks").every((e) => e.results.some((c) => c.name === "test" && c.ok)));
    assert.ok(loop.calls.includes("architect: saw the brief"), "each goal's architect reads the spec");
    assert.deepEqual(
      loop.ev("coverage").map((e) => e.missing),
      [[]],
      "one coverage check once the queue ran dry",
    );
  });

  test("orch split: a big brief becomes queued goals; --propose only shows them, --accept queues edited ones", () => {
    const dir = repo();
    assert.match(orch(dir, ["split"]).out, /usage: orch split/);
    const prop = orch(dir, ["split", "--propose", "Build part A and part B"]);
    assert.equal(prop.code, 0, prop.out);
    assert.ok(prop.calls.includes("split: fresh=false brief=Build part A and part B setup=false"), prop.calls.join("\n"));
    assert.ok(
      prop.calls.some((c) => /^call agent=architect mode=default /.test(c)),
      "read-only",
    );
    assert.deepEqual(prop.last("split_proposal").goals, ["[A] Build part A", "[B] Build part B"], "junk entries dropped");
    assert.equal(prop.last("split_proposal").cost, 0.05);
    assert.equal(prop.last("split_proposal").queued, false, "a UI may offer to queue it");
    assert.deepEqual(prop.last("split_proposal").after, [[], [1]], "B said nothing: it needs every earlier goal");
    assert.ok(!existsSync(join(dir, ".orchestrator", "queue.json")), "nothing queued");

    // The UI's path: edited goals and the brief on stdin.
    const acc = spawnSync(process.execPath, [TSX, ORCH, "split", "--accept"], {
      cwd: dir,
      input: JSON.stringify({ brief: "Build part A and part B", goals: ["[A] Build part A, carefully", "[B] Build part B"] }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_BIN: FAKE },
    });
    assert.equal(acc.status, 0, acc.stderr);
    const q = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.deepEqual(
      q.map((i) => [i.goal, i.fromSpec]),
      [
        ["[A] Build part A, carefully", true],
        ["[B] Build part B", true],
      ],
    );
    assert.equal(readFileSync(join(dir, ".orchestrator", "spec.md"), "utf8"), "Build part A and part B\n");

    // A brief from a file the backends wrote for it is deleted after reading.
    const file = join(dir, "..", `${dir.split(/[\\/]/).pop()}-brief.md`);
    writeFileSync(file, "Build part A and part B");
    const f = orch(dir, ["split", "--brief-file", file, "--brief-file-temp"]);
    assert.equal(f.code, 0, f.out);
    assert.equal(f.last("split_proposal").queued, true, "already queued: a UI must not offer it again");
    assert.ok(!existsSync(file));
    assert.equal(JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8")).length, 4);
  });

  test("brief goals with dependencies: a failed goal is retried a tier up, then blocks the goals that need it; others go on", () => {
    const dir = repo();
    const r = orch(dir, ["split", "--start", "--max-rounds", "1", "--no-coverage", "brief"], {
      FAKE_QA: "pass",
      FAKE_SPLIT: "deps",
      FAKE_QA_FAIL_GOAL: "part A",
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ev("queue_item").map((e) => e.goal),
      ["[A] Build part A", "[A] Build part A", "[C] Build part C alone"],
      "A, A again, then C; B never runs",
    );
    assert.deepEqual(
      r.ev("goal_start").map((e) => e.power),
      ["heavy", "max", "heavy"],
      "the retry runs a tier higher",
    );
    assert.deepEqual(
      r.ev("retry").map((e) => [e.id, e.attempt, e.power]),
      [[1, 1, "max"]],
    );
    assert.deepEqual(
      r.ev("blocked").map((e) => e.id),
      [2],
    );
    assert.match(r.last("blocked").note, /needs #1, which failed; run "orch retry 1"/);
    const q = () => JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.deepEqual(
      q().map((i) => [i.id, i.status, i.after]),
      [
        [1, "failed", []],
        [2, "blocked", [1]],
        [3, "done", []],
      ],
    );
    assert.match(orch(dir, ["status"]).out, /#2 \[blocked\] \[B\] Build part B on A \(after #1\)/);

    // After a fix: retry puts the goal and what it blocked back, with a fresh retry budget.
    assert.match(orch(dir, ["retry", "3"]).out, /only a failed or blocked goal/);
    assert.equal(orch(dir, ["retry", "1"]).code, 0);
    assert.deepEqual(
      q().map((i) => [i.id, i.status, i.attempts]),
      [
        [1, "pending", undefined],
        [2, "pending", undefined],
        [3, "done", undefined],
      ],
    );
    const again = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--no-coverage"], { FAKE_QA: "pass" });
    assert.deepEqual(
      again.ev("queue_item").map((e) => e.id),
      [1, 2],
      "B waits for A, then runs",
    );
  });

  test("--branch with a brief: its goals share one branch and build on each other; a failed one is parked; one PR", () => {
    const FAKE_GH = join(ROOT, "test", "fake-gh", process.platform === "win32" ? "gh.cmd" : "gh");
    const dir = repo();
    const origin = mkdtempSync(join(tmpdir(), "yaaiorch-origin-"));
    dirs.push(origin);
    git(origin, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", origin);
    const main = git(dir, "rev-parse", "main");
    const ghLog = `${dir}.gh.log`;
    const r = orch(dir, ["split", "--start", "--max-rounds", "1", "--no-coverage", "--retries", "0", "--pr", "Build the brief"], {
      FAKE_QA: "pass",
      FAKE_SPLIT: "deps",
      FAKE_QA_FAIL_GOAL: "part C",
      GH_BIN: FAKE_GH,
      FAKE_GH_LOG: ghLog,
    });
    assert.equal(r.code, 0, r.out);
    const shared = r.ev("goal_branch").map((e) => e.branch);
    assert.equal(new Set(shared).size, 1, "one branch for the whole brief");
    assert.match(shared[0], /^orch\/brief-[0-9a-z]+-build-the-brief$/);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(dir, "rev-parse", "main"), main, "main unchanged");
    // B is built on top of A on the shared branch; C failed and was parked, not left under later work.
    assert.deepEqual(git(dir, "log", "--format=%s", `main..${shared[0]}`).split("\n"), [
      "orch: [B] Build part B on A (round 1)",
      "orch: [A] Build part A (round 1)",
    ]);
    assert.equal(branches(dir, "orchestrator/failed-*").length, 1);
    assert.deepEqual(branches(dir, "orchestrator/checkpoint-*"), []);
    // One pull request, opened after A and updated after B.
    // (gh is also asked for the PR's CI checks after each goal; only one pull request is created.)
    const calls = readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((c) => c.args[0] === "pr" && c.args[1] === "create");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 6), ["pr", "create", "--base", "main", "--head", shared[0]]);
    assert.equal(calls[0].args[7], "Build the brief");
    assert.match(calls[0].body, /^Build the brief\n/);
    assert.deepEqual(
      r.ev("pr").map((e) => !!e.updated),
      [false, true],
    );
    assert.equal(git(origin, "rev-parse", shared[0]), git(dir, "rev-parse", shared[0]), "the update was pushed");
  });

  test("orch split --start builds the goals, then a coverage check queues what is missing (at most twice)", () => {
    const dir = repo();
    const r = orch(dir, ["split", "--start", "--max-rounds", "1", "Build part A and part B"], { FAKE_QA: "pass", FAKE_COVERAGE: "missing-once" });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ev("queue_item").map((e) => e.goal),
      ["[A] Build part A", "[B] Build part B", "[C] Build the part that was missed"],
    );
    assert.deepEqual(
      r.ev("coverage").map((e) => [e.pass, e.missing.length]),
      [
        [1, 1],
        [2, 0],
      ],
    );
    assert.ok(r.calls.includes("coverage: sawGoals=true missing"));
    assert.equal(r.calls.filter((c) => c.startsWith("coverage:")).length, 2);
    // Each goal keeps what it cost and how long it took, for the UI's progress.
    for (const i of JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"))) {
      assert.equal(i.cost, 0.25, `#${i.id}`);
      assert.ok(Number.isInteger(i.seconds) && i.seconds >= 0, `#${i.id}`);
    }
    // Nothing new since the last check: no third one.
    assert.equal(orch(dir, ["loop", "--until-empty"], { FAKE_COVERAGE: "missing" }).ev("coverage").length, 0);

    const off = orch(repo(), ["split", "--start", "--no-coverage", "--max-rounds", "1", "brief"], { FAKE_QA: "pass", FAKE_COVERAGE: "missing" });
    assert.equal(off.code, 0, off.out);
    assert.equal(off.ev("coverage").length, 0);
    assert.equal(off.ev("goal_end").length, 2);
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

  test("a goal cut short by the usage limit resumes from its parked work instead of starting over", () => {
    for (const branchMode of [false, true]) {
      const dir = repo();
      orch(dir, ["add", "build it"]);
      const extra = branchMode ? ["--branch"] : [];
      // Calls: 1 architect, 2-4 implementers, 5 QA: the limit hits just before QA, after the work was committed.
      const first = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--on-limit", "stop", ...extra], { FAKE_QA: "pass", FAKE_LIMIT_ON: "5" });
      assert.equal(first.code, 3, first.out);
      const item = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"))[0];
      assert.equal(item.status, "pending");
      assert.ok(item.resumeFrom, `the parked work is remembered (${branchMode ? "goal branch" : "interrupted-*"})`);
      assert.ok(branches(dir, item.resumeFrom).length === 1, item.resumeFrom);

      const again = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", ...extra], { FAKE_QA: "pass" });
      assert.equal(again.code, 0, again.out);
      assert.deepEqual(again.last("resumed")?.commits, ["orch: build it (round 1)"], again.out);
      assert.ok(again.calls.includes("architect: resumed with 1 commit(s)"), again.calls.join("\n"));
      assert.equal(again.last("goal_end").passed, true);
      assert.deepEqual(branches(dir, item.resumeFrom), [], "the parked branch is used up");
      const done = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"))[0];
      assert.equal(done.status, "done");
      assert.equal(done.resumeFrom, undefined);
      // The first attempt's commit is part of the finished goal, under the second attempt's.
      const where = branchMode ? again.last("goal_branch").branch : "main";
      assert.deepEqual(git(dir, "log", "--format=%s", where).split("\n").slice(0, 3), ["orch: build it (round 1)", "orch: build it (round 1)", "init"]);
    }
  });

  test("orch intake: GitHub issues with a label and unchecked backlog items are queued once each", () => {
    const FAKE_GH = join(ROOT, "test", "fake-gh", process.platform === "win32" ? "gh.cmd" : "gh");
    const dir = repo();
    const issues = JSON.stringify([
      { number: 5, title: "Add export", body: "As CSV.", labels: ["orch"] },
      { number: 3, title: "Fix the crash", body: "", labels: ["orch"] },
      { number: 4, title: "Not for orch", body: "", labels: ["question"] },
    ]);
    const env = { GH_BIN: FAKE_GH, FAKE_GH_ISSUES: issues, FAKE_GH_LOG: `${dir}.gh.log` };
    const r = orch(dir, ["intake", "--github", "orch"], env);
    assert.equal(r.code, 0, r.out);
    const q = () => JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.deepEqual(
      q().map((i) => [i.id, i.issue, i.goal]),
      [
        [1, 3, "Fix the crash"],
        [2, 5, "Add export\n\nAs CSV."],
      ],
      "oldest issue first; only the label's",
    );
    const call = JSON.parse(readFileSync(`${dir}.gh.log`, "utf8").trim().split("\n")[0]);
    assert.deepEqual(call.args.slice(0, 6), ["issue", "list", "--label", "orch", "--state", "open"]);
    assert.match(orch(dir, ["intake", "--github", "orch"], env).out, /nothing new/, "never twice, whatever their status");

    writeFileSync(join(dir, "BACKLOG.md"), "# Backlog\n\n- [ ] Add dark mode\n  to the settings page\n- [x] Old done thing\n- [ ] Speed up search\n\nNotes.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "backlog");
    assert.equal(orch(dir, ["intake", "--backlog", "BACKLOG.md"]).code, 0);
    assert.deepEqual(
      q()
        .slice(2)
        .map((i) => [i.id, i.goal, typeof i.backlog]),
      [
        [3, "Add dark mode\nto the settings page", "string"],
        [4, "Speed up search", "string"],
      ],
    );
    assert.match(orch(dir, ["intake", "--backlog", "BACKLOG.md"]).out, /nothing new in BACKLOG\.md/);
    assert.equal(readFileSync(join(dir, "BACKLOG.md"), "utf8").includes("- [ ] Add dark mode"), true, "the file is not changed");

    assert.match(orch(dir, ["intake"]).out, /usage: orch intake/);
    assert.match(orch(dir, ["intake", "--github", "orch"], { GH_BIN: join(dir, "no-gh") }).out, /gh \(GitHub CLI\) was not found/);
    assert.match(orch(dir, ["loop", "--intake", "jira:x"]).out, /is not github:LABEL or backlog:FILE/);
  });

  test("loop --intake pulls new issues in when the queue runs dry; with --pr the PR closes the issue", () => {
    const FAKE_GH = join(ROOT, "test", "fake-gh", process.platform === "win32" ? "gh.cmd" : "gh");
    const dir = repo();
    const origin = mkdtempSync(join(tmpdir(), "yaaiorch-origin-"));
    dirs.push(origin);
    git(origin, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", origin);
    const ghLog = `${dir}.gh.log`;
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--no-coverage", "--intake", "github:orch", "--pr"], {
      FAKE_QA: "pass",
      GH_BIN: FAKE_GH,
      FAKE_GH_LOG: ghLog,
      FAKE_GH_ISSUES: JSON.stringify([{ number: 12, title: "Add export", body: "As CSV." }]),
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ev("intake").map((e) => e.ids),
      [[1]],
    );
    assert.equal(r.last("goal_end").passed, true);
    const create = readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((c) => c.args[0] === "pr");
    assert.match(create.body, /Closes #12/);
    assert.equal(r.ev("goal_start").length, 1, "the issue is not picked up again");
  });

  test("protected paths: a plan touching one is sent back; a change there anyway is reverted and fails the round", () => {
    const dir = repo();
    const plan = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_BE_FILE: ".github/workflows/ci.yml" });
    assert.notEqual(plan.code, 0);
    assert.match(plan.out, /file "\.github\/workflows\/ci\.yml" is protected \("\.github\/workflows\/"/);
    assert.ok(plan.calls.includes("architect: got rejection reason"), "the architect is told why");

    const stray = repo();
    const r = orch(stray, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_STRAY_FILE: ".github/workflows/x.yml" });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.last("protected").files, [".github/workflows/x.yml"]);
    assert.ok(!existsSync(join(stray, ".github", "workflows", "x.yml")), "reverted");
    assert.match(r.last("round_end").failures.join("\n"), /changed protected paths \(they were reverted\): \.github\/workflows\/x\.yml/);
    assert.equal(git(stray, "ls-files", ".github"), "", "never committed");

    // Your own list replaces the default; [] protects nothing.
    const open = repo();
    writeConfig(open, { protect: [] });
    const o = orch(open, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_STRAY_FILE: ".github/workflows/x.yml" });
    assert.equal(o.code, 0, o.out);
    assert.equal(o.ev("protected").length, 0);
    const custom = orch(repo(), ["run", "x", "--max-rounds", "1", "--protect", "src/api.ts"], { FAKE_QA: "pass" });
    assert.match(custom.out, /file "src\/api\.ts" is protected/);
  });

  test("secret scan: a key in the changes is never committed and fails the round; the fix round commits clean work", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "2"], { FAKE_QA: "pass", FAKE_SECRET_ONCE: "be" });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ev("secrets").map((e) => e.found.map((x) => [x.file, x.what])),
      [[["src/api.ts", "an AWS access key"]]],
    );
    assert.doesNotMatch(r.out, /AKIAABCDEFGHIJKLMNOP/, "the value is never printed");
    assert.match(r.ev("round_end")[0].failures.join("\n"), /an AWS access key in src\/api\.ts: secrets must never be committed/);
    assert.deepEqual(
      r.ev("round_end").map((e) => e.passed),
      [false, true],
    );
    assert.doesNotMatch(git(dir, "log", "-p", "--all"), /AKIA[A-Z]{16}/, "no commit anywhere holds it");

    // An .env file is a secret by convention; .env.example is not.
    const env = repo();
    const e = orch(env, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_STRAY_FILE: ".env" });
    assert.equal(e.code, 1);
    assert.deepEqual(e.last("secrets").found, [{ file: ".env", what: "an .env file" }]);
    const ex = orch(repo(), ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_STRAY_FILE: ".env.example" });
    assert.equal(ex.code, 0, ex.out);

    const off = repo();
    const o = orch(off, ["run", "x", "--max-rounds", "1", "--no-secret-scan"], { FAKE_QA: "pass", FAKE_SECRET_ONCE: "be" });
    assert.equal(o.code, 0, o.out);
    assert.equal(o.ev("secrets").length, 0);
  });

  test("issues: priority labels order the goals; each issue hears when its goal starts, is done, fails or is blocked", () => {
    const FAKE_GH = join(ROOT, "test", "fake-gh", process.platform === "win32" ? "gh.cmd" : "gh");
    const dir = repo();
    const ghLog = `${dir}.gh.log`;
    const env = {
      FAKE_QA: "pass",
      GH_BIN: FAKE_GH,
      FAKE_GH_LOG: ghLog,
      FAKE_QA_FAIL_GOAL: "Broken thing",
      FAKE_GH_ISSUES: JSON.stringify([
        { number: 2, title: "Later thing", body: "", labels: ["orch", "priority: low"] },
        { number: 3, title: "Broken thing", body: "", labels: ["orch"] },
        { number: 4, title: "Urgent thing", body: "", labels: ["orch", "p1"] },
      ]),
    };
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--retries", "0", "--no-coverage", "--intake", "github:orch"], env);
    assert.equal(r.code, 0, r.out);
    const q = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    assert.deepEqual(
      q.map((i) => [i.issue, i.priority]),
      [
        [2, 5],
        [3, undefined],
        [4, 1],
      ],
    );
    assert.deepEqual(
      r.ev("queue_item").map((e) => e.goal),
      ["Urgent thing", "Broken thing", "Later thing"],
      "p1 first, then normal, then low",
    );

    const comments = readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((c) => c.args[1] === "comment");
    const on = (n) => comments.filter((c) => c.args[2] === String(n)).map((c) => c.body.split("\n")[0]);
    assert.deepEqual(on(4), ["Working on this now (queue goal 3, power heavy).", "Done."]);
    assert.equal(on(3)[1], "Could not finish this.");
    assert.match(comments.find((c) => c.args[2] === "3" && c.body.startsWith("Could not")).body, /fake failure for this goal[\s\S]*orch retry 2/);
    assert.ok(
      comments.every((c) => c.args.includes("--body-file") && !/#\d/.test(c.body.split("\n")[0])),
      "no #N that GitHub would link to an issue",
    );

    const quiet = repo();
    const q2 = orch(quiet, ["loop", "--until-empty", "--max-rounds", "1", "--no-coverage", "--intake", "github:orch", "--no-issue-comments"], {
      ...env,
      FAKE_GH_LOG: `${quiet}.gh.log`,
    });
    assert.equal(q2.code, 0, q2.out);
    assert.ok(!readFileSync(`${quiet}.gh.log`, "utf8").includes('"comment"'));
  });

  test("--pr watches the pull request's CI; a failing check gets a fix goal on the PR branch, pushed, then CI passes", () => {
    const FAKE_GH = join(ROOT, "test", "fake-gh", process.platform === "win32" ? "gh.cmd" : "gh");
    const setup = () => {
      const dir = repo();
      const origin = mkdtempSync(join(tmpdir(), "yaaiorch-origin-"));
      dirs.push(origin);
      git(origin, "init", "-q", "--bare");
      git(dir, "remote", "add", "origin", origin);
      return { dir, origin };
    };
    const env = (dir, checks) => ({
      FAKE_QA: "pass",
      GH_BIN: FAKE_GH,
      FAKE_GH_LOG: `${dir}.gh.log`,
      FAKE_GH_CHECKS: checks,
      ORCH_CI_POLL_MS: "20",
      ORCH_CI_NONE_MS: "200",
    });

    const { dir, origin } = setup();
    const main = git(dir, "rev-parse", "main");
    const r = orch(dir, ["run", "Add export", "--max-rounds", "1", "--pr"], env(dir, "pending,fail,pass"));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ev("ci").map((e) => [e.state, e.attempt, e.failed]),
      [
        ["fail", 0, ["test"]],
        ["pass", 1, []],
      ],
    );
    assert.deepEqual(
      r.ev("goal_start").map((e) => e.goal),
      ["Add export", `Fix CI of ${r.last("pr").url}`],
    );
    assert.ok(r.calls.includes("architect: ci fix with log"), "the fix goal gets the failing log");
    const branch = r.last("goal_branch").branch;
    assert.equal(git(origin, "rev-parse", branch), git(dir, "rev-parse", branch), "the fix was pushed to the PR branch");
    assert.equal(git(dir, "log", "-1", "--format=%s", branch), "orch: fix CI of Add export (round 1)", "the fix round's commit is on top");
    assert.equal(Number(git(dir, "rev-list", "--count", `main..${branch}`)), 2);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(dir, "rev-parse", "main"), main);
    assert.equal(lastRun(dir).ci, "pass");
    assert.deepEqual(branches(dir, "orchestrator/checkpoint-*"), []);

    // --ci-fixes 0 only reports; --no-ci-watch does not wait at all.
    const a = setup();
    const only = orch(a.dir, ["run", "x", "--max-rounds", "1", "--pr", "--ci-fixes", "0"], env(a.dir, "fail"));
    assert.equal(only.code, 0, only.out);
    assert.deepEqual(
      only.ev("ci").map((e) => e.state),
      ["fail"],
    );
    assert.equal(only.ev("goal_start").length, 1);
    assert.equal(lastRun(a.dir).ci, "fail");
    const b = setup();
    const none = orch(b.dir, ["run", "x", "--max-rounds", "1", "--pr", "--no-ci-watch"], env(b.dir, "fail"));
    assert.equal(none.ev("ci").length, 0);
    const c = setup();
    assert.deepEqual(
      orch(c.dir, ["run", "x", "--max-rounds", "1", "--pr"], env(c.dir, "none"))
        .ev("ci")
        .map((e) => e.state),
      ["none"],
    );
  });

  test("--max-cost-total: the loop stops before the next goal once its budget is spent", () => {
    const dir = repo();
    for (const g of ["one", "two", "three"]) orch(dir, ["add", g]);
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--max-cost-total", "0.4"], { FAKE_QA: "pass" });
    assert.equal(r.code, 0, r.out);
    const q = JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8"));
    // The goal the budget ran out in is not at fault: it stays pending (so nothing that needs it is blocked).
    assert.deepEqual(
      q.map((i) => i.status),
      ["done", "pending", "pending"],
      r.out,
    );
    assert.match(q[1].note, /queue's budget ran out during this goal/);
    assert.equal(r.ev("retry").length, 0, "no retry for a budget stop");
    assert.equal(r.last("loop_stop").reason, "budget");
    assert.ok(r.last("loop_stop").spent > 0.25, "the second goal's spending counts too");
    assert.match(r.out, /loop budget of \$0\.40 used up/);
    assert.notEqual(orch(dir, ["loop", "--max-cost-total", "0"]).code, 0, "0 is rejected");

    // A bigger budget carries on where it stopped.
    const more = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--max-cost-total", "2"], { FAKE_QA: "pass" });
    assert.equal(more.code, 0, more.out);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, ".orchestrator", "queue.json"), "utf8")).map((i) => i.status),
      ["done", "done", "done"],
    );

    // A goal's own --max-cost is different: that goal costs too much, so it fails (and is not retried).
    const own = repo();
    orch(own, ["add", "pricey"]);
    const o = orch(own, ["loop", "--until-empty", "--max-rounds", "1", "--max-cost", "0.1", "--max-cost-total", "5"], { FAKE_QA: "pass" });
    assert.equal(o.code, 0, o.out);
    assert.equal(JSON.parse(readFileSync(join(own, ".orchestrator", "queue.json"), "utf8"))[0].status, "failed");
    assert.equal(o.ev("retry").length, 0);
  });

  test("phantom completion: a task that claims success without a diff is re-dispatched once", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "1"], { FAKE_QA: "pass", FAKE_NOWRITE: "1" });
    assert.equal(r.calls.filter((c) => c.startsWith("call agent=be ")).length, 2, "be asked twice");
    assert.equal(r.ev("task_end").find((e) => e.agent === "be").status, "PHANTOM");
    assert.match(r.out, /phantom completion by be; re-dispatching/);
    // The retry continues the same session and is told which files did not change.
    assert.ok(r.calls.includes("be: phantom nudge"), r.calls.join("\n"));
    assert.ok(
      r.calls.some((c) => /^be: resume=fake-be-\S+ fork=true/.test(c)),
      r.calls.join("\n"),
    );
  });

  test("session resume: a fix round continues each implementer's session on the same files", () => {
    const dir = repo();
    const r = orch(dir, ["run", "x", "--max-rounds", "3"], { FAKE_QA: "fail-once" });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.ev("round_start").length, 2);
    const starts = (round) => r.ev("task_start").filter((e) => e.round === round && e.phase !== "verify");
    assert.ok(starts(1).every((e) => e.resumed === undefined));
    // fe had two tasks (types, ui) and continues each one's own session; be continues its own.
    assert.deepEqual(
      starts(2).map((e) => [e.agent, e.resumed]),
      [
        ["fe", 1],
        ["be", 1],
        ["fe", 1],
      ],
    );
    const resumes = r.calls.filter((c) => / resume=/.test(c));
    assert.equal(resumes.length, 3, resumes.join("\n"));
    assert.equal(new Set(resumes.map((c) => /resume=(\S+)/.exec(c)[1])).size, 3, "three different sessions");
    for (const c of resumes) assert.match(c, /fork=true .* files=true$/);
    // QA is never resumed; the resumed prompt is the task alone (the session has the brief already).
    assert.ok(!r.calls.some((c) => c.startsWith("qa: resume=")));
  });

  test("session resume: off with --no-resume, cold after a stuck round, cold again if the session is gone", () => {
    const off = orch(repo(), ["run", "x", "--max-rounds", "2", "--no-resume"], { FAKE_QA: "fail-once" });
    assert.equal(off.code, 0, off.out);
    assert.ok(!off.calls.some((c) => / resume=/.test(c)));
    assert.ok(off.ev("task_start").every((e) => e.resumed === undefined));

    // Round 2 resumes; it fails the same way, so round 3 (after the stuck round) starts cold.
    const stuck = orch(repo(), ["run", "x", "--max-rounds", "3"], { FAKE_QA: "fail" });
    const resumedIn = (round) => stuck.ev("task_start").filter((e) => e.round === round && e.resumed);
    assert.equal(resumedIn(2).length, 3, stuck.out);
    assert.equal(resumedIn(3).length, 0);

    const gone = orch(repo(), ["run", "x", "--max-rounds", "2"], { FAKE_QA: "fail-once", FAKE_NO_SESSION: "1" });
    assert.equal(gone.code, 0, gone.out);
    assert.match(gone.out, /be: resuming its session failed .*; starting cold/);
    assert.equal(gone.ev("task_end").filter((e) => e.round === 2 && e.status === "COMPLETE").length, 3);
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
    const r = orch(dir, ["loop", "--until-empty", "--max-rounds", "1", "--retries", "0"], { FAKE_QA: "fail" });
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
    // The interrupted attempt's work was brought back into the retry, so its branch is used up.
    assert.equal(r.ev("resumed").length, 1);
    assert.equal(branches(dir, "orchestrator/interrupted-*").length, 0);
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
    // The first attempt's work was set aside, then brought back into the retry.
    assert.deepEqual(
      r.ev("resumed").map((e) => e.commits.length),
      [1],
    );
    assert.equal(branches(dir, "orchestrator/interrupted-*").length, 0);
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
