// Unit tests for orch.ts's parsing and validation helpers. orch.ts is a CLI; ORCH_NO_MAIN stops it from
// running when imported, and tsx loads the TypeScript.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let o;

before(async () => {
  process.env.ORCH_NO_MAIN = "1";
  const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
  const { tsImport } = await import(pathToFileURL(api).href);
  o = await tsImport(pathToFileURL(join(root, "orch.ts")).href, import.meta.url);
});

describe("extractJson", () => {
  test("a fenced block wins over prose", () => {
    assert.deepEqual(o.extractJson('Here:\n```json\n{"a": 1}\n```\nand {"b": 2}'), { a: 1 });
  });
  test("the outermost object in prose", () => {
    assert.deepEqual(o.extractJson('Sure. {"summary": "s", "tasks": [{"x": {"y": 1}}]} Done.'), { summary: "s", tasks: [{ x: { y: 1 } }] });
  });
  test("no JSON is an error", () => {
    assert.throws(() => o.extractJson("nothing here"), /no valid JSON/);
    assert.throws(() => o.extractJson("{ not json"), /no valid JSON/);
  });
});

describe("validate", () => {
  const roster = ["fe", "be", "qa"].map((name) => ({ name, description: name }));
  const plan = (tasks) => ({ summary: "s", tasks: [...tasks, { agent: "qa", phase: "verify", task: "check" }] });
  test("a good plan passes", () => {
    assert.doesNotThrow(() => o.validate(plan([{ agent: "fe", phase: "build", task: "t", files: ["src/a.ts"] }]), roster));
  });
  test("rejections name the problem", () => {
    const cases = [
      [plan([{ agent: "zz", phase: "build", task: "t", files: ["a"] }]), /unknown agent "zz"/],
      [plan([{ agent: "fe", phase: "later", task: "t", files: ["a"] }]), /invalid phase "later"/],
      [plan([{ agent: "fe", phase: "build", task: "t" }]), /lists no files/],
      [plan([{ agent: "fe", phase: "build", task: " ", files: ["a"] }]), /no task text/],
      [{ summary: "s", tasks: [{ agent: "fe", phase: "build", task: "t", files: ["a"] }] }, /no verify task/],
      [{ summary: "s", tasks: [] }, /at least one task/],
      [plan(Array.from({ length: 30 }, (_, i) => ({ agent: "fe", phase: "build", task: "t", files: [`f${i}`] }))), /at most 25/],
    ];
    for (const [p, why] of cases) assert.throws(() => o.validate(p, roster), why);
  });
  test("the same file in two tasks, however it is spelled", () => {
    const p = plan([
      { agent: "fe", phase: "build", task: "t", files: ["./src/a.ts"] },
      { agent: "be", phase: "build", task: "t", files: [process.platform === "win32" ? "SRC\\A.ts" : "src/a.ts"] },
    ]);
    assert.throws(() => o.validate(p, roster), /owned by both fe and be/);
  });
  test("visual: verify tasks only, checked, defaults filled in, at most 5 pages in all", () => {
    const p = { summary: "s", tasks: [{ agent: "qa", phase: "verify", task: "v", visual: [{ path: "/settings", selector: "#x" }] }] };
    o.validate(p, roster);
    assert.deepEqual(p.tasks[0].visual, [{ path: "/settings", selector: "#x", viewports: [1280, 375], themes: ["light"] }]);
    assert.throws(() => o.validate(plan([{ agent: "fe", phase: "build", task: "t", files: ["a"], visual: [{ path: "/" }] }]), roster), /only verify tasks/);
    const many = (n) => ({ agent: "qa", phase: "verify", task: "v", visual: Array.from({ length: n }, () => ({ path: "/" })) });
    assert.throws(() => o.validate({ summary: "s", tasks: [many(3), many(3)] }, roster), /6 pages together; at most 5/);
  });
});

describe("badPath", () => {
  test("paths that leave the repo or touch its internals", () => {
    const repo = mkdtempSync(join(tmpdir(), "yaaiorch-unit-"));
    const outside = mkdtempSync(join(tmpdir(), "yaaiorch-unit-out-"));
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      mkdirSync("src");
      symlinkSync(outside, join(repo, "out"), "junction");
      assert.equal(o.badPath("src/new/file.ts"), null);
      assert.equal(o.badPath("./src/x.ts"), null);
      assert.match(o.badPath("../x"), /leave the repo/);
      assert.match(o.badPath("/etc/passwd"), /relative/);
      assert.match(o.badPath("C:/x"), /relative/);
      assert.match(o.badPath("\\\\server\\share\\x"), /relative/);
      assert.match(o.badPath("~/x"), /relative/);
      assert.match(o.badPath(".git/config"), /\.git/);
      assert.match(o.badPath(".orchestrator/queue.json"), /\.orchestrator/);
      assert.match(o.badPath("out/x.ts"), /through a link/);
      assert.match(o.badPath(""), /empty/);
      assert.match(o.badPath("a\u0001b"), /control characters/);
    } finally {
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("saveAgent", () => {
  test("writes only valid repo-local agent definitions", () => {
    const repo = mkdtempSync(join(tmpdir(), "yaaiorch-agent-"));
    const cwd = process.cwd();
    const definition = "---\nname: helper\ndescription: A focused helper\n---\n\nDo the work.\n";
    try {
      process.chdir(repo);
      assert.equal(o.saveAgent("helper", definition), join(repo, ".claude", "agents", "helper.md"));
      assert.equal(readFileSync(join(repo, ".claude", "agents", "helper.md"), "utf8"), definition);
      assert.throws(() => o.saveAgent("../outside", definition), /agent name/);
      assert.throws(() => o.saveAgent("helper", definition.replace("name: helper", "name: other")), /frontmatter name/);
      assert.throws(() => o.saveAgent("helper", "---\nname: helper\n---\n\nDo the work.\n"), /description is required/);
      assert.throws(() => o.saveAgent("helper", "---\nname: helper\ndescription: Missing body\n---\n\n"), /instructions are required/);
    } finally {
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("parseReset", () => {
  test("times with and without a zone; nothing without a time", () => {
    const now = Date.now();
    for (const text of ["resets 1:30am (Europe/London)", "resets 14:00", "resets 9pm", "resets 3am (Not/AZone)"]) {
      const t = o.parseReset(`You've hit your 5-hour limit · ${text}`);
      assert.equal(typeof t, "number", text);
      assert.ok(t > now && t <= now + 24 * 3_600_000 + 60_000, text);
    }
    const london = new Date(o.parseReset("resets 1:30am (Europe/London)"));
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(london), "01:30");
    assert.equal(o.parseReset("You've hit your limit"), undefined);
    assert.equal(o.parseReset("resets 25:00"), undefined);
  });
});

describe("failureKey, verdicts and reviews", () => {
  test("failureKey ignores case, spacing, numbers and order", () => {
    assert.equal(o.failureKey(["Test A failed in 12 ms", "check  b"]), o.failureKey(["CHECK B", "test a failed in 340 ms"]));
    assert.notEqual(o.failureKey(["a"]), o.failureKey(["b"]));
  });
  test("asVerdict", () => {
    assert.deepEqual(o.asVerdict({ passed: false }), { passed: false, failures: ["QA failed without listing failures"] });
    assert.deepEqual(o.asVerdict({ passed: true, failures: [], notes: [" a ", "", "b", "c", "d"] }).notes, ["a", "b", "c"]);
    assert.throws(() => o.asVerdict({ passed: "yes" }), /boolean/);
  });
  test("asReview: a rejection without issues counts as approval", () => {
    assert.deepEqual(o.asReview({ approved: false, issues: [] }), { approved: true, issues: [] });
    assert.deepEqual(o.asReview({ approved: false, issues: ["x"] }), { approved: false, issues: ["x"] });
  });
  test("TRANSIENT_RE: API trouble yes; usage limit, timeouts and task output no", () => {
    for (const t of [
      'be: CLI returned success: API Error: 529 {"type":"overloaded_error"}',
      "API Error: 500 Internal",
      "API Error: 429 rate_limit_error",
      "connect ECONNRESET",
      "fetch failed",
    ])
      assert.ok(o.TRANSIENT_RE.test(t), t);
    for (const t of [
      "You've hit your 5-hour limit",
      "be timed out after 30 min",
      "be: CLI returned error_during_execution: 500 tests failed",
      "budget of $1.00 used up",
    ])
      assert.ok(!o.TRANSIENT_RE.test(t), t);
  });
});

describe("claude-bin: start claude without a shell on Windows", () => {
  let cb, dir;
  before(async () => {
    const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
    const { tsImport } = await import(pathToFileURL(api).href);
    cb = await tsImport(pathToFileURL(join(root, "claude-bin.ts")).href, import.meta.url);
    dir = mkdtempSync(join(tmpdir(), "yaaiorch-bin-"));
  });
  const env = (d) => ({ PATH: d, PATHEXT: ".COM;.EXE;.BAT;.CMD" });
  const file = (p, text = "") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, text));

  test("other platforms spawn the name as given", () => {
    assert.deepEqual(cb.resolveClaude("claude", {}, "linux"), { file: "claude", pre: [], shell: false, via: "claude" });
  });
  test("an .exe on PATH runs directly", () => {
    const d = join(dir, "exe");
    file(join(d, "claude.exe"));
    file(join(d, "claude")); // npm's POSIX shim is never picked on Windows
    const c = cb.resolveClaude("claude", env(d), "win32");
    assert.equal(c.file, join(d, "claude.exe"));
    assert.equal(c.shell, false);
  });
  test("npm's .cmd shim is unwrapped to node + its script", () => {
    const d = join(dir, "npm");
    const cli = join(d, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    file(cli);
    file(join(d, "claude"));
    file(
      join(d, "claude.cmd"),
      "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n" +
        'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n' +
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    );
    const c = cb.resolveClaude("claude", env(d), "win32");
    assert.deepEqual([c.file, c.pre, c.shell], [process.execPath, [cli], false]);
  });
  test("a %~dp0 shim given as a path with spaces and & is unwrapped", () => {
    const d = join(dir, "a b&c");
    file(join(d, "fake.mjs"));
    file(join(d, "claude.cmd"), '@node "%~dp0fake.mjs" %*\r\n');
    const c = cb.resolveClaude(join(d, "claude.cmd"), {}, "win32");
    assert.deepEqual([c.file, c.pre, c.shell], [process.execPath, [join(d, "fake.mjs")], false]);
  });
  test("an unknown shim falls back to cmd.exe, quoted; a missing claude is reported", () => {
    const d = join(dir, "odd dir");
    file(join(d, "claude.cmd"), "@echo hi\r\n");
    const c = cb.resolveClaude("claude", env(d), "win32");
    assert.deepEqual([c.file, c.shell], [`"${join(d, "claude.cmd")}"`, true]);
    assert.match(c.via, /unrecognised shim/);
    // Not found: never spawned (cmd.exe and Node would both look in the current directory first).
    assert.deepEqual(cb.resolveClaude("claude", env(join(dir, "none")), "win32").missing, true);
  });
  test("the current directory is not searched", () => {
    const d = join(dir, "cwd");
    file(join(d, "claude.cmd"), '@node "%~dp0x.mjs" %*\r\n');
    const prev = process.cwd();
    process.chdir(d);
    try {
      assert.equal(cb.findOnPath("claude", env(join(dir, "none"))), undefined);
    } finally {
      process.chdir(prev);
    }
  });
});

describe("notification texts (orch-ui/src/notifyText.ts)", () => {
  let n;
  before(async () => {
    const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
    const { tsImport } = await import(pathToFileURL(api).href);
    n = (await tsImport(pathToFileURL(join(root, "orch-ui", "src", "notifyText.ts")).href, import.meta.url)).notificationFor;
  });
  test("a goal that passed or failed, a waiting plan, the usage limit", () => {
    assert.deepEqual(n("shop", "Add  CSV\nexport", { type: "goal_end", passed: true }), { title: "shop: goal passed", body: "Add CSV export" });
    assert.deepEqual(n("shop", "g", { type: "goal_end", passed: false, error: "budget used up" }), { title: "shop: goal failed", body: "g\nbudget used up" });
    assert.equal(n("shop", "g", { type: "approval_wait", summary: "two tasks" }).title, "shop: plan waiting for you");
    assert.match(n("shop", "g", { type: "waiting", reason: "usage_limit", until: Date.now() + 60_000 }).title, /usage limit/);
    assert.match(n("shop", "g", { type: "waiting", reason: "usage_cap", until: Date.now() }).title, /usage cap/);
    assert.deepEqual(n("shop", "g", { type: "blocked", id: 4, note: "needs #2, which failed" }), {
      title: "shop: goal #4 is blocked",
      body: "needs #2, which failed",
    });
  });
  test("nothing for routine events or a goal cut short by the usage limit", () => {
    for (const e of [{ type: "task_end" }, { type: "plan" }, { type: "goal_end", passed: false, usageLimit: true }, { type: "loop_stop", reason: "requested" }])
      assert.equal(n("shop", "g", e), null, e.type);
  });
});

describe("per-repo run settings", () => {
  let settings;
  before(async () => {
    const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
    const { tsImport } = await import(pathToFileURL(api).href);
    settings = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "Settings.tsx")).href, import.meta.url);
  });

  function storage(t) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const data = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, value),
      },
    });
    t.after(() => (previous ? Object.defineProperty(globalThis, "localStorage", previous) : delete globalThis.localStorage));
    return data;
  }

  test("preserves old advanced settings and restores separate repo values", (t) => {
    const data = storage(t);
    data.set("yaaiorch.settings:repo-a", JSON.stringify({ fast: true, models: { qa: "sonnet" }, plugins: { on: false } }));
    const old = settings.loadRepoSettings("repo-a");
    assert.equal(old.error, undefined);
    assert.equal(old.settings.power, "heavy");
    assert.equal(old.settings.maxRounds, 5);
    assert.equal(old.settings.models.qa, "sonnet");
    assert.equal(old.settings.models.impl, "");
    assert.deepEqual(old.settings.plugins, { on: false, off: [], hooks: true });

    const a = { ...old.settings, power: "economy", maxRounds: 8, maxCost: "2.5", queueBudget: "30" };
    const b = { ...settings.loadRepoSettings("repo-b").settings, power: "max", maxRounds: 2, maxCost: "", queueBudget: "10" };
    assert.equal(settings.saveRepoSettings("repo-a", a), undefined);
    assert.equal(settings.saveRepoSettings("repo-b", b), undefined);
    assert.deepEqual(settings.loadRepoSettings("repo-a").settings, a);
    assert.deepEqual(settings.loadRepoSettings("repo-b").settings, b);
    assert.equal(settings.loadRepoSettings("repo-c").settings.power, "heavy");
  });

  test("reports invalid stored values and unavailable storage", (t) => {
    const data = storage(t);
    data.set("yaaiorch.settings:bad", JSON.stringify({ power: "unknown", maxRounds: "8", maxCost: {}, queueBudget: "invalid", fast: true }));
    const result = settings.loadRepoSettings("bad");
    assert.match(result.error, /invalid/);
    assert.deepEqual(
      [result.settings.power, result.settings.maxRounds, result.settings.maxCost, result.settings.queueBudget, result.settings.fast],
      ["heavy", 5, "", "", true],
    );
    data.set("yaaiorch.settings:bad", "{");
    assert.match(settings.loadRepoSettings("bad").error, /Could not read/);
    globalThis.localStorage.getItem = () => {
      throw new Error("blocked");
    };
    globalThis.localStorage.setItem = () => {
      throw new Error("blocked");
    };
    assert.match(settings.loadRepoSettings("bad").error, /Could not read/);
    assert.match(settings.saveRepoSettings("bad", result.settings), /Could not save/);
  });
});

describe("brief progress (orch-ui/src/progress.ts)", () => {
  let p;
  before(async () => {
    const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
    const { tsImport } = await import(pathToFileURL(api).href);
    p = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "progress.ts")).href, import.meta.url);
  });
  test("counts the newest brief only, with cost and a time guess", () => {
    const q = [
      { id: 1, goal: "old", status: "done", brief: "a", cost: 9, seconds: 999 },
      { id: 2, goal: "x", status: "done", brief: "b", cost: 0.5, seconds: 60 },
      { id: 3, goal: "y", status: "failed", brief: "b", cost: 1, seconds: 120 },
      { id: 4, goal: "z", status: "blocked", brief: "b", after: [3] },
      { id: 5, goal: "w", status: "running", brief: "b" },
      { id: 6, goal: "v", status: "pending", brief: "b" },
      { id: 7, goal: "plain", status: "pending" },
    ];
    const r = p.briefProgress(q);
    assert.deepEqual({ ...r, running: r.running.id }, { total: 5, done: 1, failed: 1, blocked: 1, running: 5, cost: 1.5, secondsLeft: 180 });
    assert.equal(p.briefProgress([{ id: 1, goal: "g", status: "pending" }]), null, "no brief: no progress");
    assert.equal(p.briefProgress([{ id: 1, goal: "g", status: "pending", brief: "b" }]).secondsLeft, undefined, "nothing finished yet");
  });
  test("time left wording", () => {
    assert.equal(p.leftText(30), "under a minute left");
    assert.equal(p.leftText(25 * 60), "about 25 min left");
    assert.equal(p.leftText(3 * 3600), "about 3 h left");
  });
});

describe("open in editor (orch-ui/src/editorLinks.ts)", () => {
  let o;
  before(async () => {
    const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
    const { tsImport } = await import(pathToFileURL(api).href);
    o = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "editorLinks.ts")).href, import.meta.url);
  });
  test("editor URLs for Windows and POSIX paths", () => {
    assert.equal(o.editorUrl("vscode", "D:\\code\\my app"), "vscode://file/D:/code/my%20app");
    assert.equal(o.editorUrl("cursor", "/home/me/proj"), "cursor://file/home/me/proj");
    assert.equal(o.editorUrl("vscode", "/srv/a#b?c"), "vscode://file/srv/a%23b%3Fc");
  });
  test("file manager name", () => {
    assert.equal(o.fileManager("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Explorer");
    assert.equal(o.fileManager("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Finder");
    assert.equal(o.fileManager("Mozilla/5.0 (X11; Linux x86_64)"), "file manager");
  });
});

describe("run view (orch-ui/src/reduce.ts)", () => {
  let reduce;
  before(async () => {
    const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
    const { tsImport } = await import(pathToFileURL(api).href);
    ({ reduce } = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "reduce.ts")).href, import.meta.url));
  });
  const fold = (events) => events.reduce((run, e, i) => reduce(run, { t: 1000 + i, ...e }), null);
  const start = [
    { type: "goal_start", goal: "g", maxRounds: 3, dryRun: false, maxCost: 2 },
    { type: "round_start", round: 1, power: "heavy", models: { impl: "sonnet" } },
    {
      type: "plan",
      round: 1,
      summary: "s",
      cost: 0.05,
      tokens: { input: 15, output: 5, cacheRead: 3, cacheCreation: 2 },
      tasks: [
        { id: 0, agent: "be", phase: "build", task: "t", files: ["a.js"] },
        { id: 1, agent: "qa", phase: "verify", task: "v" },
      ],
    },
  ];

  test("a goal from start to pass: tasks, costs, reviews, checks", () => {
    const run = fold([
      ...start,
      { type: "task_start", round: 1, id: 0, resumed: 1 },
      {
        type: "task_end",
        round: 1,
        id: 0,
        status: "COMPLETE",
        touched: ["a.js"],
        report: "Done",
        reportTruncated: true,
        cost: 0.05,
        tokens: { input: 15, output: 5, cacheRead: 3, cacheCreation: 2 },
      },
      {
        type: "review",
        round: 1,
        agent: "reviewer",
        lens: "bugs",
        approved: true,
        issues: [],
        cost: 0.05,
        tokens: { input: 15, output: 5, cacheRead: 3, cacheCreation: 2 },
      },
      { type: "checks", round: 1, results: [{ name: "test", ok: true }] },
      {
        type: "round_end",
        round: 1,
        passed: true,
        failures: [],
        cost: 0.2,
        tokens: { input: 45, output: 15, cacheRead: 9, cacheCreation: 6 },
        diff: { text: "+change\n", truncated: true },
      },
      { type: "goal_end", passed: true, cost: 0.2, tokens: { input: 45, output: 15, cacheRead: 9, cacheCreation: 6 } },
    ]);
    assert.equal(run.status, "passed");
    assert.equal(run.cost, 0.2, "goal_end has the last word on cost");
    assert.deepEqual(run.tokens, { input: 45, output: 15, cacheRead: 9, cacheCreation: 6 });
    const r = run.rounds[0];
    assert.deepEqual(r.architectTokens, { input: 15, output: 5, cacheRead: 3, cacheCreation: 2 });
    assert.deepEqual(r.tokens, run.tokens);
    assert.deepEqual([r.architect, r.summary, r.passed, r.checks[0].name], ["done", "s", true, "test"]);
    assert.deepEqual(
      r.tasks.map((t) => [t.agent, t.status, t.resumed]),
      [
        ["be", "COMPLETE", 1],
        ["qa", "queued", undefined],
      ],
    );
    assert.deepEqual(r.tasks[0].tokens, { input: 15, output: 5, cacheRead: 3, cacheCreation: 2 });
    assert.equal(r.tasks[0].report, "Done");
    assert.equal(r.tasks[0].reportTruncated, true);
    assert.deepEqual(r.diff, { text: "+change\n", truncated: true });
    assert.deepEqual(r.reviews[0].tokens, { input: 15, output: 5, cacheRead: 3, cacheCreation: 2 });
    assert.deepEqual(
      r.reviews.map((v) => [v.agent, v.lens, v.approved]),
      [["reviewer", "bugs", true]],
    );
    // Before goal_end, the cost is the sum of what each event reported.
    const mid = fold([
      ...start,
      { type: "task_end", round: 1, id: 0, status: "COMPLETE", cost: 0.05 },
      { type: "review", round: 1, agent: "c", lens: "goal", approved: false, issues: ["x"], cost: 0.05 },
    ]);
    assert.ok(Math.abs(mid.cost - 0.15) < 1e-9, String(mid.cost));
  });

  test("approval: the plan waits for the user, then the panel goes away", () => {
    const waiting = fold([
      ...start.slice(0, 2),
      { type: "architect_start", round: 1 },
      { type: "approval_wait", round: 1, summary: "s", tasks: [{ agent: "be", phase: "build", task: "t" }] },
    ]);
    assert.equal(waiting.approval.summary, "s");
    assert.equal(waiting.rounds[0].architect, "done", "no longer planning");
    assert.equal(reduce(waiting, { type: "approval", round: 1, action: "approve", t: 9 }).approval, undefined);
  });

  test("a round diff stays visible if a goal stops before round_end", () => {
    const run = fold([...start, { type: "round_diff", round: 1, diff: { text: "+work\n" } }, { type: "goal_end", passed: false }]);
    assert.deepEqual(run.rounds[0].diff, { text: "+work\n" });
  });

  test("stopped: a run killed mid-task fails and its open tasks show STOPPED; a finished run is left alone", () => {
    const killed = reduce(fold([...start, { type: "task_start", round: 1, id: 0 }]), { type: "stopped", t: 5000 });
    assert.equal(killed.status, "failed");
    assert.match(killed.error, /Stopped/);
    assert.deepEqual(
      killed.rounds[0].tasks.map((t) => t.status),
      ["STOPPED", "STOPPED"],
    );
    const done = fold([...start, { type: "goal_end", passed: true, cost: 0.05 }]);
    assert.equal(reduce(done, { type: "stopped", t: 1 }), done);
  });

  test("stuck notes, branch and PR, and events without a run", () => {
    const run = fold([
      ...start,
      { type: "stuck", round: 1, action: "escalate", reason: "same failures", agents: { be: "max" } },
      { type: "goal_branch", branch: "orch/1-g", base: "main" },
      { type: "pr", url: "https://example.com/pr/1" },
    ]);
    assert.match(run.rounds[0].note, /only the failing tasks move up next round \(be at max\)/);
    assert.deepEqual(run.branch, { name: "orch/1-g", base: "main" });
    assert.equal(run.pr.url, "https://example.com/pr/1");
    assert.equal(reduce(null, { type: "plan", round: 1, tasks: [], t: 1 }), null, "nothing to fold into before goal_start");
    assert.equal(reduce(run, { type: "something_new", t: 1 }), run, "unknown events change nothing");
  });
});

describe("protected paths and secret formats", () => {
  test("protect patterns", () => {
    const hit = (p, f) => o.protectRe(p).test(f);
    assert.ok(hit(".github/workflows/", ".github/workflows/ci.yml"));
    assert.ok(!hit(".github/workflows/", ".github/dependabot.yml"));
    assert.ok(hit("infra", "infra/main.tf") && hit("infra", "infra"));
    assert.ok(!hit("infra", "infrastructure/x"));
    assert.ok(hit("*.pem", "key.pem") && !hit("*.pem", "certs/key.pem"));
    assert.ok(hit("**/*.pem", "certs/deep/key.pem"));
    assert.ok(hit("db/migrations/**", "db/migrations/001.sql"));
    assert.equal(o.protectedBy(".\\.github\\workflows\\x.yml", [".github/workflows/"]), ".github/workflows/");
    assert.equal(o.protectedBy("src/a.ts", [".github/workflows/"]), undefined);
  });
  test("secret formats: real-looking keys yes, ordinary code no", () => {
    const found = (text) => o.SECRETS.filter(([, re]) => re.test(text)).map(([what]) => what);
    const k = (...parts) => parts.join("");
    assert.deepEqual(found(k("AKIA", "ABCDEFGHIJKLMNOP")), ["an AWS access key"]);
    assert.deepEqual(found(k("ghp_", "a".repeat(36))), ["a GitHub token"]);
    assert.deepEqual(found(k("sk-ant-", "api03-", "x".repeat(30))), ["an Anthropic API key"]);
    assert.deepEqual(found(k("-----BEGIN ", "OPENSSH PRIVATE KEY-----")), ["a private key"]);
    for (const ok of ["const sk = 'sk-test'", "AKIA is a prefix", "process.env.API_KEY", "ghp_short", "-----BEGIN PUBLIC KEY-----"])
      assert.deepEqual(found(ok), [], ok);
    assert.ok(o.ENV_FILE.test(".env") && o.ENV_FILE.test("api/.env.local") && o.ENV_FILE.test(".env.production"));
    assert.ok(!o.ENV_FILE.test(".env.example") && !o.ENV_FILE.test("src/env.ts") && !o.ENV_FILE.test(".envrc.sample"));
  });
});

describe("priority from labels", () => {
  test("p1-p9, prefixed, and words", () => {
    assert.equal(o.priorityOf(["bug", "p1"]), 1);
    assert.equal(o.priorityOf(["orch:p2"]), 2);
    assert.equal(o.priorityOf(["Priority: High"]), 2);
    assert.equal(o.priorityOf(["urgent"]), 1);
    assert.equal(o.priorityOf(["priority/low"]), 5);
    assert.equal(o.priorityOf(["bug", "enhancement"]), undefined);
    assert.equal(o.priorityOf(["p0", "p10"]), undefined);
  });
});

describe("browser checks (orch-browser.ts)", () => {
  let b;
  let reduce;
  before(async () => {
    const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
    const { tsImport } = await import(pathToFileURL(api).href);
    b = await tsImport(pathToFileURL(join(root, "orch-browser.ts")).href, import.meta.url);
    ({ reduce } = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "reduce.ts")).href, import.meta.url));
  });

  test("only this machine's app", () => {
    for (const u of ["http://localhost:5173", "http://127.0.0.1:3000/club", "http://[::1]:8080", "https://app.localhost"])
      assert.equal(b.isLocalUrl(u), true, u);
    for (const u of ["https://example.com", "http://localhost.evil.com", "file:///etc/passwd", "http://10.0.0.5", "not a url"])
      assert.equal(b.isLocalUrl(u), false, u);
    assert.throws(() => b.parseServe({ url: "https://example.com" }), /must be on this machine/);
    assert.throws(() => b.parseServe({ url: "http://localhost:1", command: "" }), /non-empty string/);
    assert.throws(() => b.parseServe({ url: "http://localhost:1", timeout: 0 }), /timeout/);
    assert.deepEqual(b.parseServe({ url: "http://localhost:1", command: "npm run dev", extra: 1 }), { url: "http://localhost:1", command: "npm run dev" });
  });

  test("targets: paths in the app, safe actions, limits", () => {
    const bad = [
      [{ path: "https://example.com/" }, /path must start with "\/"/],
      [{ path: "//evil.com/x" }, /path must start/],
      [{ path: "/a b" }, /path must start/],
      [{ path: "/", actions: [{ type: "hello" }] }, /must be \{"click"/],
      [{ path: "/", actions: [{ click: "" }] }, /CSS selector/],
      [{ path: "/", actions: [{ wait: 60_000 }] }, /CSS selector/],
      [{ path: "/", viewports: [100] }, /viewports/],
      [{ path: "/", viewports: [1, 2, 3, 4] }, /viewports/],
      [{ path: "/", themes: ["sepia"] }, /themes/],
    ];
    for (const [t, why] of bad) assert.throws(() => b.validateTargets([t], "task 1"), why, JSON.stringify(t));
    assert.throws(() => b.validateTargets([], "task 1"), /non-empty/);
    assert.deepEqual(
      b.validateTargets([{ path: "/x?tab=2", actions: [{ click: "#a" }, { wait: 200 }, { wait: ".b" }], viewports: [375, 375], themes: ["dark"] }], "t"),
      [{ path: "/x?tab=2", actions: [{ click: "#a" }, { wait: 200 }, { wait: ".b" }], viewports: [375], themes: ["dark"] }],
    );
  });

  test("screenshot names and the report QA gets", () => {
    assert.equal(b.shotName(0, "/", 1280, "light"), "1-home-1280-light.png");
    assert.equal(b.shotName(2, "/Settings/Profile?tab=1", 375, "dark"), "3-settings-profile-375-dark.png");
    const r = {
      url: "http://localhost:5173",
      shots: [
        { target: 0, path: "/", viewport: 1280, theme: "light", file: ".orchestrator/visual/round-1/1-home-1280-light.png" },
        { target: 1, path: "/b", viewport: 375, theme: "dark", file: ".orchestrator/visual/round-1/2-b-375-dark.png" },
      ],
      problems: ["/c answered HTTP 404"],
      observations: ["/: console errors: boom"],
      ms: 10,
    };
    const mine = b.visualReport(r, [1]);
    assert.match(mine, /## Browser check/);
    assert.match(mine, /2-b-375-dark\.png: \/b at 375px, dark theme \(required\)/);
    // One required screenshot per page and theme: the narrowest.
    const shot = (target, viewport, theme) => ({ target, path: `/p${target}`, viewport, theme, file: `${target}-${viewport}-${theme}.png` });
    const all = b.visualReport(
      { ...r, shots: [shot(0, 1280, "light"), shot(0, 375, "light"), shot(0, 1280, "dark"), shot(0, 375, "dark"), shot(1, 1280, "light")] },
      [0, 1],
    );
    const req = all.split("\n").filter((l) => l.endsWith("(required)"));
    assert.deepEqual(
      req.map((l) => l.split(":")[0]),
      ["- 0-375-light.png", "- 0-375-dark.png", "- 1-1280-light.png"],
    );
    assert.doesNotMatch(mine, /1-home/);
    assert.match(mine, /already fail the round\):\n- \/c answered HTTP 404/);
    assert.match(mine, /console errors: boom/);
    assert.equal(b.visualReport({ ...r, shots: [], problems: [], observations: [] }, []), "");
  });

  test("where browsers are looked for", () => {
    const win = b.browserCandidates("win32", { ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\L" });
    assert.equal(win[0], "C:\\PF\\Google\\Chrome\\Application\\chrome.exe");
    assert.ok(win.some((p) => p.includes("msedge.exe")));
    assert.ok(b.browserCandidates("darwin", {}, "/Users/u").includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
    assert.deepEqual(b.browserCandidates("linux").slice(0, 2), ["google-chrome", "google-chrome-stable"]);
    assert.equal(b.cftPlatform("win32", "x64"), "win64");
    assert.equal(b.cftPlatform("darwin", "arm64"), "mac-arm64");
    assert.equal(b.cftPlatform("linux", "arm64"), undefined);
    assert.ok(b.cftExecutable("linux64").endsWith(join("chrome-linux64", "chrome")));
    assert.notEqual(b.profileDir("/a/repo"), b.profileDir("/b/repo"));
  });

  test("the run view folds the visual event into its round", () => {
    const events = [
      { type: "goal_start", goal: "g", maxRounds: 1, dryRun: false },
      { type: "round_start", round: 1, power: "heavy" },
      { type: "plan", round: 1, summary: "s", tasks: [{ id: 0, agent: "qa", phase: "verify", task: "v" }] },
      {
        type: "visual",
        round: 1,
        url: "http://localhost:1",
        shots: [{ path: "/", viewport: 375, theme: "light", file: "f.png" }],
        problems: ["p"],
        observations: [],
        ms: 5,
      },
    ];
    const run = events.reduce((acc, e, i) => reduce(acc, { t: i, ...e }), null);
    assert.deepEqual(run.rounds[0].visual, {
      url: "http://localhost:1",
      shots: [{ path: "/", viewport: 375, theme: "light", file: "f.png" }],
      problems: ["p"],
      observations: [],
      ms: 5,
    });
  });
});
