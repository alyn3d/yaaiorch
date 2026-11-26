// Unit tests for orch.ts's parsing and validation helpers. orch.ts is a CLI; ORCH_NO_MAIN stops it from
// running when imported, and tsx loads the TypeScript.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { tsxApi } from "./tsx.mjs";
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let o;

before(async () => {
  process.env.ORCH_NO_MAIN = "1";
  const { tsImport } = await tsxApi(root);
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

describe("task activity stream", () => {
  test("reads split JSON lines, ignores content, and resumes after an oversized line", () => {
    const activities = [];
    const read = o.activityReader((activity) => activities.push(activity));
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "private" } },
          { type: "tool_use", name: "custom-secret-tool" },
        ],
      },
    });
    read(line.slice(0, 12));
    assert.deepEqual(activities, []);
    read(line.slice(12) + "\nnot json\n");
    read("x".repeat(1_000_001));
    read("\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "secret" } }] } }) + "\n");
    assert.deepEqual(activities, ["read", "other", "command"]);
  });
});

describe("validate", () => {
  const roster = ["fe", "be", "qa"].map((name) => ({ name, description: name }));
  const plan = (tasks) => ({ summary: "s", tasks: [...tasks, { agent: "qa", phase: "verify", task: "check" }] });
  test("a good plan passes", () => {
    assert.doesNotThrow(() => o.validate(plan([{ agent: "fe", phase: "build", task: "t", files: ["src/a.ts"] }]), roster));
  });
  test("normalizes planned paths before agents use them", () => {
    const p = plan([{ agent: "fe", phase: "build", task: "t", files: [" .\\src\\Mixed.ts "] }]);
    o.validate(p, roster);
    assert.deepEqual(p.tasks[0].files, ["src/Mixed.ts"]);
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

describe("run history: listing reads only the ends of large runs, and old runs are pruned", () => {
  let h, dir;
  const here = process.cwd();
  before(async () => {
    const { tsImport } = await tsxApi(root);
    h = await tsImport(pathToFileURL(join(root, "orch-history.ts")).href, import.meta.url);
  });
  const inRepo = (fn) => {
    dir = mkdtempSync(join(tmpdir(), "yaaiorch-history-"));
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(here);
    }
  };
  const runFile = (ms, events) => {
    const id = `${ms}-12345678-1234-4234-8234-123456789abc`;
    mkdirSync(join(".orchestrator", "runs"), { recursive: true });
    writeFileSync(join(".orchestrator", "runs", `${id}.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
    return id;
  };
  const start = { type: "goal_start", t: 1, goal: "Big goal", maxRounds: 3 };
  const filler = (n) => Array.from({ length: n }, (_, i) => ({ type: "task_activity", t: 2 + i, pad: "x".repeat(1000) }));

  test("a large run is summarized from its first line and its goal_end near the end", () =>
    inRepo(() => {
      const id = runFile(1700000000000, [start, ...filler(600), { type: "goal_end", t: 9, passed: true, cost: 1.25 }]);
      assert.deepEqual(h.listRunHistory(), [{ id, goal: "Big goal", startedAt: 1, endedAt: 9, status: "passed", cost: 1.25, truncated: undefined }]);
    }));

  test("a goal_end far from the end is still found (full read), and damage near the end makes it unreadable", () =>
    inRepo(() => {
      const id = runFile(1700000000000, [start, { type: "goal_end", t: 5, passed: false, cost: 0.5 }, ...filler(600)]);
      assert.equal(h.listRunHistory()[0].status, "failed");
      writeFileSync(join(".orchestrator", "runs", `${id}.jsonl`), [start, ...filler(600)].map((e) => JSON.stringify(e)).join("\n") + "\n{broken\n");
      const [entry] = h.listRunHistory();
      assert.equal(entry.status, "unreadable");
      assert.match(entry.error, /invalid run history/);
    }));

  test("a limit reads only the newest runs; a new run prunes beyond ORCH_HISTORY_KEEP", () =>
    inRepo(() => {
      const ids = [1, 2, 3, 4].map((n) => runFile(1700000000000 + n, [start, { type: "goal_end", t: 5, passed: true, cost: 0 }]));
      assert.deepEqual(
        h.listRunHistory(2).map((e) => e.id),
        [ids[3], ids[2]],
      );
      process.env.ORCH_HISTORY_KEEP = "3";
      try {
        const created = h.createRunHistory();
        const left = readdirSync(join(".orchestrator", "runs")).sort();
        assert.equal(left.length, 3);
        assert.ok(left.includes(created.split(/[\\/]/).pop()), "the new run is kept");
        assert.ok(!left.includes(`${ids[0]}.jsonl`) && !left.includes(`${ids[1]}.jsonl`), "the oldest go");
      } finally {
        delete process.env.ORCH_HISTORY_KEEP;
      }
    }));
});

describe("Agent M answers: Markdown subset (orch-ui/src/markdown.ts)", () => {
  let md;
  before(async () => {
    const { tsImport } = await tsxApi(root);
    md = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "markdown.ts")).href, import.meta.url);
  });
  test("sentences: split at a real sentence end only, never in code, quotes, brackets or after an abbreviation", () => {
    assert.deepEqual(md.splitSentences("In server.js, add `sort`. Read it from the URL; empty keeps the order. Tests: two items."), [
      "In server.js, add `sort`.",
      "Read it from the URL; empty keeps the order.",
      "Tests: two items.",
    ]);
    assert.deepEqual(md.splitSentences("Use a guard (e.g. a counter. Or AbortController) here. Done."), [
      "Use a guard (e.g. a counter. Or AbortController) here.",
      "Done.",
    ]);
    assert.deepEqual(md.splitSentences('Return {"error":"bad. Value"} as JSON. Then stop.'), ['Return {"error":"bad. Value"} as JSON.', "Then stop."]);
    assert.deepEqual(md.splitSentences("Call `a. B` first. See e.g. Foo, i.e. Bar, and U.S. Rules. Ok!"), [
      "Call `a. B` first.",
      "See e.g. Foo, i.e. Bar, and U.S. Rules.",
      "Ok!",
    ]);
    assert.deepEqual(md.splitSentences("GET /api/items?max=8. 400 for bad input. Version 1.2 ships. then lowercase stays."), [
      "GET /api/items?max=8.",
      "400 for bad input.",
      "Version 1.2 ships. then lowercase stays.",
    ]);
  });
  test("structureText: a long single paragraph becomes one bullet per sentence; short or structured text stays", () => {
    const long = "Make GET /api/items accept `sort`. ".repeat(4) + "Keep /health unchanged.";
    assert.equal(md.structureText(long, 100), "- Make GET /api/items accept `sort`.\n".repeat(4) + "- Keep /health unchanged.");
    assert.equal(md.structureText("Short. Two sentences."), "Short. Two sentences.");
    assert.equal(md.structureText("Line one.\n\nLine two is longer. " + "x".repeat(300)), "Line one.\n\nLine two is longer. " + "x".repeat(300));
    assert.equal(md.structureText("one very long sentence " + "word ".repeat(80)), ("one very long sentence " + "word ".repeat(80)).trim());
  });
  test("inline: bold, italic, code (literal inside), http links only", () => {
    assert.deepEqual(md.parseInline("Run **npm test** or `a **b**` then *fast* and _slow_ in snake_case_name"), [
      { kind: "text", text: "Run " },
      { kind: "bold", text: "npm test" },
      { kind: "text", text: " or " },
      { kind: "code", text: "a **b**" },
      { kind: "text", text: " then " },
      { kind: "italic", text: "fast" },
      { kind: "text", text: " and " },
      { kind: "italic", text: "slow" },
      { kind: "text", text: " in snake_case_name" },
    ]);
    assert.deepEqual(md.parseInline("[docs](https://example.com/a) [bad](javascript:alert(1))"), [
      { kind: "link", text: "docs", href: "https://example.com/a" },
      { kind: "text", text: " [bad](javascript:alert(1))" },
    ]);
  });
  test("blocks: headings, paragraphs joined, lists by kind, wrapped items, fenced code kept as is", () => {
    const blocks = md.parseMarkdown(
      [
        "## Connected",
        "Two servers",
        "are up.",
        "",
        "- figma",
        "- github",
        "  with a wrapped line",
        "1. first",
        "2) second",
        "```bash",
        "npm i **x**",
        "",
        "  indented",
        "```",
        "tail",
      ].join("\r\n"),
    );
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ["heading", "paragraph", "list", "list", "code", "paragraph"],
    );
    assert.equal(blocks[0].level, 2);
    assert.deepEqual(blocks[1].inline, [{ kind: "text", text: "Two servers are up." }]);
    assert.equal(blocks[2].ordered, false);
    assert.equal(blocks[2].items.length, 2);
    assert.equal(blocks[2].items[1].map((s) => s.text).join(""), "github with a wrapped line");
    assert.equal(blocks[3].ordered, true);
    assert.equal(blocks[3].items.length, 2);
    assert.deepEqual(blocks[4], { kind: "code", lang: "bash", text: "npm i **x**\n\n  indented" });
    assert.deepEqual(md.parseMarkdown("```\nnever closed"), [{ kind: "code", lang: "", text: "never closed" }]);
    assert.deepEqual(md.parseMarkdown(""), []);
  });
});

describe("remote access: pairing and roles (orch-ui/remote.ts, tunnel.ts)", () => {
  let r, t, dir;
  before(async () => {
    const { tsImport } = await tsxApi(root);
    r = await tsImport(pathToFileURL(join(root, "orch-ui", "remote.ts")).href, import.meta.url);
    t = await tsImport(pathToFileURL(join(root, "orch-ui", "tunnel.ts")).href, import.meta.url);
    dir = mkdtempSync(join(tmpdir(), "yaaiorch-remote-"));
  });

  const pair = (remote, name = "Pixel") => {
    const code = remote.newCode();
    const req = remote.request(code, name, "Mozilla/5.0 (Android)", "1.1.1.1");
    assert.ok(req.id && req.poll, JSON.stringify(req));
    return req;
  };

  test("a code works once; the PC allows; the phone's poll gets a view-only device once", () => {
    const file = join(dir, "a.json");
    const remote = new r.Remote(file);
    const code = remote.newCode();
    const req = remote.request(code, "Pixel\u0007 phone", "UA", "1.1.1.1");
    assert.ok("id" in req);
    assert.ok("error" in remote.request(code, "again", "UA", "1.1.1.1"), "single use");
    assert.deepEqual(remote.status(req.id, req.poll), { status: "waiting" });
    assert.deepEqual(remote.status(req.id, "wrong poll"), { status: "unknown" }, "the poll secret is needed");
    assert.equal(remote.requests()[0].name, "Pixel  phone", "control characters are dropped");
    assert.ok(remote.decide(req.id, true));
    const ok = remote.status(req.id, req.poll);
    assert.equal(ok.status, "allowed");
    assert.equal(ok.device.role, "view", "new devices only view");
    assert.equal(ok.device.keyHash, undefined, "the key hash never leaves the server");
    assert.deepEqual(remote.status(req.id, req.poll), { status: "unknown" }, "the key is handed out once");
    const saved = readFileSync(file, "utf8");
    assert.ok(!saved.includes(ok.cookie.split(".")[1]), "only a hash of the key is stored");
    assert.equal(new r.Remote(file).authenticate(`${r.COOKIE}=${ok.cookie}`)?.id, ok.device.id, "devices survive a restart");
    assert.equal(remote.authenticate(`${r.COOKIE}=${ok.device.id}.wrongkey`), null);
    assert.equal(remote.authenticate(undefined), null);
  });

  test("a denied request gets no device; a revoked device is refused; roles change", () => {
    const remote = new r.Remote(join(dir, "b.json"));
    const no = pair(remote);
    remote.decide(no.id, false);
    assert.deepEqual(remote.status(no.id, no.poll), { status: "denied" });
    const yes = pair(remote, "Tablet");
    remote.decide(yes.id, true);
    const { cookie, device } = remote.status(yes.id, yes.poll);
    assert.ok(remote.setRole(device.id, "control"));
    assert.equal(remote.authenticate(`a=b; ${r.COOKIE}=${cookie}`).role, "control");
    assert.ok(!remote.setRole(device.id, "admin"), "only view or control");
    assert.ok(remote.revoke(device.id));
    assert.equal(remote.authenticate(`${r.COOKIE}=${cookie}`), null);
  });

  test("codes and requests expire; wrong codes are rate-limited per address and overall", () => {
    let now = 1_000_000;
    const remote = new r.Remote(join(dir, "c.json"), () => now);
    const code = remote.newCode();
    now += r.CODE_TTL + 1;
    assert.ok("error" in remote.request(code, "x", "", "2.2.2.2"), "an old code fails");
    for (let i = 0; i < 4; i++) remote.request("guess", "x", "", "3.3.3.3");
    const fresh = remote.newCode();
    assert.match(remote.request("guess", "x", "", "3.3.3.3").error, /not valid/);
    assert.match(remote.request(fresh, "x", "", "3.3.3.3").error, /too many/, "five misses lock that address out, even with the right code");
    assert.ok("id" in remote.request(fresh, "x", "", "4.4.4.4"), "another address still pairs");
    now += 11 * 60_000;
    assert.equal(remote.requests().length, 0, "an unanswered request expires");
  });

  test("view devices only read; control devices act; some routes stay on the PC", () => {
    const no = (role, method, path, decision) => r.remoteRefusal(role, method, path, decision);
    assert.equal(no("view", "GET", "/api/state"), null);
    assert.equal(no("view", "GET", "/api/events"), null);
    assert.match(no("view", "POST", "/api/run"), /only view/);
    assert.equal(no("control", "POST", "/api/run"), null);
    assert.equal(no("control", "POST", "/api/decide-command", "allow"), null);
    assert.match(no("control", "POST", "/api/decide-command", "always"), /PC/);
    assert.match(no("control", "POST", "/api/decide-command", "prefix"), /PC/);
    for (const p of ["/api/add-repo", "/api/new-project", "/api/reveal", "/api/settings", "/api/agents", "/api/browser", "/api/group-save"])
      assert.match(no("control", "POST", p), /PC/, p);
    assert.match(no("control", "GET", "/api/token"), /PC/);
    assert.match(no("control", "GET", "/api/remote"), /PC/);
    assert.match(no("control", "POST", "/api/remote/enable"), /PC/);
    assert.equal(no("view", "GET", "/api/agents"), null, "reading the roster is fine");
  });

  test("the device cookie is HttpOnly, Secure and SameSite=Strict", () => {
    const c = r.deviceCookie("id.key");
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(c.includes(part), part);
    assert.equal(r.cookieValue(`x=1; ${r.COOKIE}=id.key; y=2`), "id.key");
  });

  test("cloudflared: the quick tunnel's address in its output; a pinned build per platform", () => {
    assert.equal(t.tunnelUrl("INF |  https://calm-river-12.trycloudflare.com   |"), "https://calm-river-12.trycloudflare.com");
    assert.equal(t.tunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com..."), null);
    assert.equal(t.tunnelUrl("https://evil.example/https://x.trycloudflare.com.evil"), "https://x.trycloudflare.com");
    for (const k of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) assert.match(t.assetFor(...k.split("-")).sha256, /^[0-9a-f]{64}$/);
    assert.equal(t.assetFor("freebsd", "x64"), null);
  });
});

describe("keep awake (orch-awake.ts)", () => {
  let a;
  before(async () => {
    const { tsImport } = await tsxApi(root);
    a = await tsImport(pathToFileURL(join(root, "orch-awake.ts")).href, import.meta.url);
  });

  test("Windows: the system PowerShell by full path, the script base64-encoded and tied to orch's PID", () => {
    const c = a.awakeCommand(4242, "win32", { SystemRoot: "D:\\Win" });
    assert.equal(c.file, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(c.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(c.args[3], "base64").toString("utf16le");
    assert.equal(script, a.windowsAwakeScript(4242));
    assert.match(script, /Get-Process -Id 4242 /);
    assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\)/, "ES_CONTINUOUS | ES_SYSTEM_REQUIRED, never the display");
  });

  test("macOS: caffeinate waits on orch's PID; idle sleep only", () => {
    assert.deepEqual(a.awakeCommand(7, "darwin", {}), { file: "/usr/bin/caffeinate", args: ["-i", "-w", "7"] });
  });

  test("Linux: systemd-inhibit from PATH around a loop that ends with orch, or nothing without it", () => {
    const bin = mkdtempSync(join(tmpdir(), "yaaiorch-awake-"));
    try {
      assert.equal(a.awakeCommand(7, "linux", { PATH: bin }), null);
      writeFileSync(join(bin, "systemd-inhibit"), "#!/bin/sh\n");
      chmodSync(join(bin, "systemd-inhibit"), 0o755);
      const c = a.awakeCommand(7, "linux", { PATH: bin });
      if (process.platform !== "win32") {
        assert.equal(c.file, join(bin, "systemd-inhibit"));
        assert.ok(c.args.includes("--what=idle"));
        assert.equal(c.args.at(-1), "while kill -0 7 2>/dev/null; do sleep 30; done");
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("no command for a bad PID or another platform", () => {
    assert.equal(a.awakeCommand(0, "win32", {}), null);
    assert.equal(a.awakeCommand(Number.NaN, "darwin", {}), null);
    assert.equal(a.awakeCommand(7, "freebsd", {}), null);
  });

  test("wantsAwake: only long commands, and --no-keep-awake wins", () => {
    const on = { "keep-awake": true };
    assert.equal(o.wantsAwake("run", ["x"], on), true);
    assert.equal(o.wantsAwake("loop", [], on), true);
    assert.equal(o.wantsAwake("new", ["."], { ...on, start: true }), true);
    assert.equal(o.wantsAwake("new", ["."], on), false);
    assert.equal(o.wantsAwake("group", ["run", "shop", "g"], on), true);
    assert.equal(o.wantsAwake("group", ["rollback", "shop"], on), false);
    assert.equal(o.wantsAwake("status", [], on), false);
    assert.equal(o.wantsAwake("run", ["x"], { ...on, "no-keep-awake": true }), false);
  });
});

describe("claude-bin: start claude without a shell on Windows", () => {
  let cb, dir;
  before(async () => {
    const { tsImport } = await tsxApi(root);
    cb = await tsImport(pathToFileURL(join(root, "claude-bin.ts")).href, import.meta.url);
    dir = mkdtempSync(join(tmpdir(), "yaaiorch-bin-"));
  });
  const env = (d) => ({ PATH: d, PATHEXT: ".COM;.EXE;.BAT;.CMD" });
  const file = (p, text = "") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, text));

  test("other platforms spawn the name as given, and say when it is not there", (t) => {
    if (process.platform === "win32") return t.skip("needs POSIX file modes");
    const d = join(dir, "posix");
    file(join(d, "claude"), "#!/bin/sh\n");
    chmodSync(join(d, "claude"), 0o755);
    file(join(d, "plain"));
    assert.deepEqual(cb.resolveClaude("claude", { PATH: `/nowhere:${d}` }, "linux"), { file: "claude", pre: [], shell: false, via: "claude" });
    assert.equal(cb.resolveClaude("claude", { PATH: "/nowhere" }, "linux").missing, true);
    assert.equal(cb.resolveClaude("plain", { PATH: d }, "linux").missing, true, "not executable");
    assert.equal(cb.resolveClaude(join(d, "claude"), {}, "linux").missing, undefined, "a path is used as given");
    assert.equal(cb.resolveClaude(join(d, "none"), { PATH: d }, "linux").missing, true);
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
    const { tsImport } = await tsxApi(root);
    n = (await tsImport(pathToFileURL(join(root, "orch-ui", "src", "notifyText.ts")).href, import.meta.url)).notificationFor;
  });
  test("a goal that passed or failed, a waiting plan, the usage limit", () => {
    assert.deepEqual(n("shop", "Add  CSV\nexport", { type: "goal_end", passed: true }), { title: "shop: goal passed", body: "Add CSV export" });
    assert.deepEqual(n("shop", "g", { type: "goal_end", passed: false, error: "budget used up" }), { title: "shop: goal failed", body: "g\nbudget used up" });
    assert.equal(n("shop", "g", { type: "approval_wait", summary: "two tasks" }).title, "shop: plan waiting for you");
    assert.deepEqual(n("shop", "g", { type: "question_wait", agent: "be", question: "private details" }), {
      title: "shop: agent needs your input",
      body: "be has a question.",
    });
    assert.deepEqual(n("shop", "g", { type: "command_wait", agent: "be", command: "npm i zod" }), {
      title: "shop: Agent M needs your approval",
      body: "be wants to run: npm i zod",
    });
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
  test("a group goal that passed or failed, a group plan waiting", () => {
    assert.deepEqual(n("shop", "orders", { type: "group_end", ok: true }), { title: "shop: group goal passed", body: "orders" });
    assert.deepEqual(n("shop", "orders", { type: "group_end", ok: false, reason: "integration failed" }), {
      title: "shop: group goal failed",
      body: "orders\nintegration failed",
    });
    assert.equal(n("shop", "orders", { type: "group_approval_wait", round: 1 }).title, "shop: group plan waiting for you");
  });
});

describe("per-repo run settings", () => {
  let settings;
  before(async () => {
    const { tsImport } = await tsxApi(root);
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
    const { tsImport } = await tsxApi(root);
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

describe("usage-limit waits (orch-ui/src/repoStatus.ts)", () => {
  let r;
  before(async () => {
    const { tsImport } = await tsxApi(root);
    r = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "repoStatus.ts")).href, import.meta.url);
  });
  const now = 1_000_000;
  const run = (extra = {}) => ({ status: "running", rounds: [], cost: 0, ...extra });
  const member = (inGroup, extra) => ({ state: { repo: "/r", running: null, queued: null, queue: [], inGroup }, run: run(extra) });
  test("a wait counts until it is over", () => {
    assert.equal(r.waitLabel(run({ waitingUntil: now + 1 }), now), "waiting for the usage limit");
    assert.equal(r.waitLabel(run({ waitingUntil: now + 1, waitingReason: "usage_cap" }), now), "paused at your usage cap");
    assert.equal(r.waitLabel(run({ waitingUntil: now }), now), null);
    // The attempt that hit the limit has ended (goal_end) before the run waits: still a wait.
    assert.equal(r.waitLabel(run({ waitingUntil: now + 1, status: "failed" }), now), "waiting for the usage limit");
    assert.equal(r.waitLabel(undefined, now), null);
  });
  test("a group run lists its own wait and its members' (only those in the group)", () => {
    const g = run({ waitingUntil: now + 60_000 });
    const w = r.groupWaits(
      g,
      [
        { role: "backend", session: member(undefined, { waitingUntil: now + 60_000 }) },
        { role: "frontend", session: member("shop", { waitingUntil: now + 60_000, status: "failed" }) },
      ],
      now,
    );
    assert.equal(w.length, 2);
    assert.match(w[0], /^coordinator: waiting for the usage limit until /);
    assert.match(w[1], /^frontend: waiting for the usage limit until /);
    assert.deepEqual(r.groupWaits(run({ status: "failed", waitingUntil: now + 1 }), [], now), []);
  });
  test("a member waiting inside a group shows the wait, not just 'in group'", () => {
    assert.equal(r.repoStatus(member("shop", { waitingUntil: now + 1 }), now).label, "waiting for the usage limit");
    assert.equal(r.repoStatus(member("shop", {}), now).label, "in group shop");
  });
});

describe("open in editor (orch-ui/src/editorLinks.ts)", () => {
  let o;
  before(async () => {
    const { tsImport } = await tsxApi(root);
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
  let reduce, roundPhases, failureSummary, taskTimeline, overviewBoard;
  before(async () => {
    const { tsImport } = await tsxApi(root);
    ({ reduce } = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "reduce.ts")).href, import.meta.url));
    ({ roundPhases, failureSummary, taskTimeline } = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "runProgress.ts")).href, import.meta.url));
    ({ overviewBoard } = await tsImport(pathToFileURL(join(root, "orch-ui", "src", "overviewBoard.ts")).href, import.meta.url));
  });
  const fold = (events) => events.reduce((run, e, i) => reduce(run, { t: 1000 + i, ...e }), null);
  test("gate checks keep their gate flag, and skipped gates are recorded on the round", () => {
    const run = fold([
      { type: "goal_start", goal: "g", maxRounds: 2 },
      { type: "round_start", round: 1, power: "economy" },
      { type: "checks", round: 1, results: [{ name: "unit", command: "u", ok: false, code: 1, ms: 1 }], gateSkipped: ["e2e"] },
      { type: "round_start", round: 2, power: "economy" },
      { type: "checks", round: 2, results: [{ name: "perf", command: "p", ok: false, code: 1, ms: 1, gate: true }] },
    ]);
    assert.deepEqual(run.rounds[0].gateSkipped, ["e2e"]);
    assert.equal(run.rounds[1].checks[0].gate, true);
    assert.equal(run.rounds[1].gateSkipped, undefined);
    assert.deepEqual(failureSummary(run).issues, ['Gate check "perf" failed (exit 1).']);
  });
  test("questions remain independently answered in the replay", () => {
    const run = fold([
      { type: "goal_start", goal: "g", maxRounds: 1 },
      { type: "question_wait", id: "a", agent: "be", question: "First?", options: ["Yes"] },
      { type: "question_wait", id: "b", agent: "fe", question: "Second?", options: [] },
      { type: "question_answered", id: "b" },
      { type: "stopped" },
    ]);
    assert.deepEqual(
      run.questions.map((q) => [q.id, q.answered]),
      [
        ["a", false],
        ["b", true],
      ],
    );
    assert.equal(run.status, "failed");
  });
  test("Agent M commands fold with their answers; one never answered stays without a decision", () => {
    const run = fold([
      { type: "goal_start", goal: "g", maxRounds: 1 },
      { type: "command_wait", id: "a", agent: "be", round: 1, taskId: 0, tool: "Bash", command: "npm i zod", description: "schema" },
      { type: "command_wait", id: "b", agent: "fe", round: 1, tool: "Bash", command: "npm i x" },
      { type: "command_wait", id: "c", agent: "fe", round: 1, tool: "Bash", command: "npm i y", prefix: "npm i" },
      { type: "command_decided", id: "a", decision: "always" },
      { type: "command_decided", id: "b", decision: "timeout" },
    ]);
    assert.deepEqual(
      run.commands.map((c) => [c.id, c.agent, c.command, c.decision]),
      [
        ["a", "be", "npm i zod", "always"],
        ["b", "fe", "npm i x", "timeout"],
        ["c", "fe", "npm i y", undefined],
      ],
    );
    assert.equal(run.commands[0].description, "schema");
    assert.equal(run.commands[0].taskId, 0);
    assert.equal(run.commands[0].prefix, undefined);
    assert.equal(run.commands[2].prefix, "npm i");
  });
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

  test("overview board groups active work, user questions, review and completed queue goals", () => {
    const makeSession = (repo, events, running = true, queue = []) => ({
      state: { repo, running: running ? { label: "run" } : null, queue, lastRun: null },
      log: [],
      run: fold(events),
    });
    const working = makeSession("repo-working", [...start, { type: "task_start", round: 1, id: 0 }]);
    const needsYou = makeSession("repo-question", [
      ...start,
      { type: "question_wait", id: "q", round: 1, taskId: 0, agent: "be", question: "Which API?", options: [] },
    ]);
    const reviewing = makeSession("repo-review", [...start, { type: "task_start", round: 1, id: 1 }]);
    const prWithPassingCI = makeSession(
      "repo-pr",
      [
        { type: "goal_start", goal: "ship it", maxRounds: 1, dryRun: false, maxCost: 2 },
        { type: "goal_end", passed: true },
        { type: "pr", url: "https://example.test/pr/1" },
        { type: "ci", state: "pass", failed: [] },
      ],
      false,
    );
    const done = makeSession("repo-done", [], false, [{ id: 4, goal: "Add export", status: "done", cost: 0.1, seconds: 61 }]);
    const order = ["repo-working", "repo-question", "repo-review", "repo-pr", "repo-done"];
    const board = overviewBoard(
      {
        "repo-working": working,
        "repo-question": needsYou,
        "repo-review": reviewing,
        "repo-pr": prWithPassingCI,
        "repo-done": done,
      },
      order,
      Date.now(),
    );
    assert.equal(board.Working[0].repo, "repo-working");
    assert.equal(board["Needs you"][0].detail, "Which API?");
    assert.equal(board["In review"][0].repo, "repo-review");
    assert.ok(
      board["In review"].some((card) => card.repo === "repo-pr"),
      "CI-passing PRs remain in review",
    );
    assert.equal(board.Done[0].repo, "repo-done");
    assert.equal(board.Done[0].title, "Add export");
    assert.match(board.Done[0].detail, /Issue|Queue goal/);
  });

  test("phase timeline shows a question wait only when all active tasks in the phase are waiting", () => {
    const planning = fold([...start.slice(0, 2), { type: "question_wait", id: "p", round: 1, agent: "architect", question: "Which?", options: [] }]);
    assert.equal(roundPhases(planning, planning.rounds[0])[0].state, "waiting");
    const plan = {
      ...start[2],
      tasks: [...start[2].tasks, { id: 2, agent: "fe", phase: "build", task: "u", files: ["b.js"] }],
    };
    const building = fold([
      ...start.slice(0, 2),
      plan,
      { type: "task_start", round: 1, id: 0 },
      { type: "task_start", round: 1, id: 2 },
      { type: "question_wait", id: "a", round: 1, taskId: 0, agent: "be", question: "First?", options: [] },
    ]);
    assert.equal(roundPhases(building, building.rounds[0])[2].state, "active");
    const waiting = reduce(building, { type: "question_wait", id: "b", round: 1, taskId: 2, agent: "fe", question: "Second?", options: [], t: 10 });
    assert.equal(roundPhases(waiting, waiting.rounds[0])[2].state, "waiting");
    const answered = reduce(waiting, { type: "question_answered", id: "a", t: 11 });
    assert.equal(roundPhases(answered, answered.rounds[0])[2].state, "active");
  });

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
    assert.equal(run.endedAt, 1008);
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

  test("history failures are visible in the live run", () => {
    const run = fold([...start, { type: "history_error", error: "Could not save run history" }]);
    assert.equal(run.historyError, "Could not save run history");
  });

  test("phase timeline follows observed events, including approval, checks, fast and plan-only runs", () => {
    const phases = (events) => {
      const run = fold(events);
      return roundPhases(run, run.rounds.at(-1)).map((p) => [p.label, p.state]);
    };
    assert.deepEqual(phases(start.slice(0, 2)), [
      ["Plan", "active"],
      ["Foundation", "pending"],
      ["Build", "pending"],
      ["Checks", "pending"],
      ["QA", "pending"],
    ]);
    assert.equal(phases([...start.slice(0, 2), { type: "approval_wait", round: 1 }])[0][1], "waiting");
    const building = [...start, { type: "task_start", round: 1, id: 0 }];
    assert.deepEqual(phases(building), [
      ["Plan", "done"],
      ["Foundation", "skipped"],
      ["Build", "active"],
      ["Checks", "pending"],
      ["QA", "pending"],
    ]);
    const checking = [...building, { type: "task_end", round: 1, id: 0, status: "COMPLETE" }, { type: "checks_start", round: 1 }];
    assert.equal(phases(checking)[3][1], "active");
    const browser = [...checking, { type: "checks", round: 1, results: [] }, { type: "visual_start", round: 1 }];
    assert.deepEqual(phases(browser).slice(3), [
      ["Checks", "skipped"],
      ["Browser", "active"],
      ["QA", "pending"],
    ]);
    assert.equal(phases([...browser, { type: "goal_end", passed: false }])[4][1], "interrupted");
    const dry = [{ type: "goal_start", goal: "g", maxRounds: 1, dryRun: true }, ...start.slice(1), { type: "goal_end", passed: true }];
    assert.deepEqual(
      phases(dry).map((p) => p[1]),
      ["done", "skipped", "skipped", "skipped", "skipped"],
    );
    assert.equal(phases([{ ...start[0] }, { type: "round_start", round: 1, mode: "direct" }])[0][1], "skipped");
    const old = [...building, { type: "task_end", round: 1, id: 0, status: "COMPLETE" }, { type: "checks", round: 1, results: [{ ok: false }] }];
    assert.equal(phases(old)[3][1], "failed", "old recordings without checks_start still show completed checks");
  });

  test("failure summary highlights the latest issue and known escalation without hiding a live retry", () => {
    const events = [...start, { type: "checks", round: 1, results: [{ name: "test", ok: false, code: 1 }] }];
    assert.match(failureSummary(fold(events)).issues[0], /test.*exit 1/);
    const failed = [
      ...events,
      { type: "round_end", round: 1, passed: false, failures: ["test output"], cost: 0 },
      { type: "stuck", round: 1, action: "escalate", reason: "same failure", power: "max" },
      { type: "round_start", round: 2 },
    ];
    const summary = failureSummary(fold(failed));
    assert.deepEqual(summary.issues, ["test output"]);
    assert.equal(summary.previous, true);
    assert.match(summary.note, /next round runs at power max/);
    assert.equal(failureSummary(fold([...failed, { type: "goal_end", passed: true }])), null);
  });

  test("task activity is bounded, matched by round and task, and ignored outside an active task", () => {
    let run = fold([...start, { type: "task_start", round: 1, id: 0 }]);
    run = reduce(run, { type: "task_activity", round: 1, id: 1, activity: "edit", t: 1 });
    for (let i = 0; i < 12; i++) run = reduce(run, { type: "task_activity", round: 1, id: 0, activity: "read", t: i + 10 });
    run = reduce(run, { type: "task_activity", round: 1, id: 0, activity: "unknown", t: 30 });
    assert.equal(run.rounds[0].tasks[0].activity.length, 8);
    assert.equal(run.rounds[0].tasks[0].activity[0].t, 14);
    assert.equal(run.rounds[0].tasks[1].activity, undefined);
    run = reduce(run, { type: "task_end", round: 1, id: 0, status: "COMPLETE", t: 40 });
    run = reduce(run, { type: "task_activity", round: 1, id: 0, activity: "edit", t: 41 });
    assert.equal(run.rounds[0].tasks[0].activity.at(-1).kind, "read");
  });

  test("task timeline positions parallel and sequential work and advances only live tasks", () => {
    const run = fold([
      ...start,
      { type: "task_start", round: 1, id: 0, t: 10000 },
      { type: "task_start", round: 1, id: 1, t: 12000 },
      { type: "task_end", round: 1, id: 0, status: "COMPLETE", t: 14000 },
    ]);
    const timeline = taskTimeline(run.rounds[0].tasks, 18000, true);
    assert.equal(timeline.span, 8000);
    assert.deepEqual(
      timeline.rows.map((r) => [r.task.id, r.offset, r.left, r.width, r.running]),
      [
        [0, 0, 0, 50, false],
        [1, 2000, 25, 75, true],
      ],
    );
    const ended = fold([
      ...start,
      { type: "task_start", round: 1, id: 0, t: 10000 },
      { type: "task_end", round: 1, id: 0, status: "COMPLETE", t: 14000 },
      { type: "task_start", round: 1, id: 1, t: 16000 },
      { type: "task_end", round: 1, id: 1, status: "PASS", t: 18000 },
      { type: "goal_end", passed: true, t: 19000 },
    ]);
    const replay = taskTimeline(ended.rounds[0].tasks, 90000, false);
    assert.deepEqual(
      replay.rows.map((r) => [r.offset, r.width, r.running]),
      [
        [0, 50, false],
        [6000, 25, false],
      ],
    );
    assert.equal(replay.span, 8000);
  });

  test("task timeline omits unstarted tasks and does not invent missing or invalid end times", () => {
    const run = fold([...start, { type: "task_start", round: 1, id: 0, t: 0 }]);
    assert.equal(taskTimeline(run.rounds[0].tasks, 0, true).rows[0].start, 0);
    assert.equal(taskTimeline(run.rounds[0].tasks, 0, true).rows.length, 1);
    const unknown = taskTimeline(run.rounds[0].tasks, 90000, false);
    assert.equal(unknown.rows[0].knownEnd, false);
    assert.equal(unknown.span, 0);
    assert.equal(taskTimeline([{ ...run.rounds[0].tasks[0], startedAt: NaN }], 1, true), null);
    const reversed = taskTimeline([{ ...run.rounds[0].tasks[0], status: "FAILED", endedAt: -1 }], 1, false);
    assert.equal(reversed.rows[0].knownEnd, false);
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
    const pushed = fold([
      ...start,
      { type: "pr", branch: "orch/1-g", base: "main", link: "https://codeberg.org/me/app/compare/main...orch/1-g", pushed: true },
    ]);
    assert.deepEqual(pushed.pr, { url: undefined, link: "https://codeberg.org/me/app/compare/main...orch/1-g", pushed: true, error: undefined });
    assert.equal(reduce(null, { type: "plan", round: 1, tasks: [], t: 1 }), null, "nothing to fold into before goal_start");
    assert.equal(reduce(run, { type: "something_new", t: 1 }), run, "unknown events change nothing");
  });

  test("group_child folds its inner event like a bare one", () => {
    const bare = fold([...start, { type: "task_start", round: 1, id: 0 }]);
    const wrapped = fold([...start, { type: "group_child", repo: "/r/api", role: "backend", event: { type: "task_start", round: 1, id: 0, t: 1003 } }]);
    assert.equal(wrapped.rounds[0].tasks[0].status, "running");
    assert.deepEqual(wrapped, bare);
    assert.equal(reduce(null, { type: "group_child", repo: "/r/api", t: 1, event: { type: "plan", round: 1, tasks: [], t: 1 } }), null);
    assert.equal(reduce(bare, { type: "group_child", t: 1 }), bare, "a group_child without an event changes nothing");
  });

  test("group events fill run.group: start, plan, steps, fault, end and rollback", () => {
    const repos = [
      { path: "/r/api", role: "backend" },
      { path: "/r/web", role: "frontend" },
    ];
    let run = fold([
      { type: "group_start", group: "shop", goal: "checkout", repos },
      { type: "group_plan", contract: "POST /orders", goals: { backend: "b", frontend: "f" }, cost: 0.25 },
      { type: "group_step", step: "build", repo: "backend", round: 1 },
    ]);
    assert.equal(run.goal, "checkout");
    assert.equal(run.status, "running");
    assert.equal(run.cost, 0.25);
    assert.deepEqual(run.group, {
      name: "shop",
      goal: "checkout",
      repos,
      contract: "POST /orders",
      goals: { backend: "b", frontend: "f" },
      step: "build",
      stepRepo: "backend",
      round: 1,
    });
    // A wrapped child goal_start must not drop the group (fallback: no session for that repo).
    run = reduce(run, { type: "group_child", repo: "/r/api", role: "backend", t: 5, event: { type: "goal_start", goal: "b", maxRounds: 2, t: 5 } });
    assert.equal(run.group.name, "shop");
    run = reduce(run, { type: "group_step", step: "integration", repo: "frontend", round: 1, external: true, t: 6 });
    assert.equal(run.group.external, true);
    run = reduce(run, { type: "group_step", step: "integration", round: 1, failed: "the backend did not come up", t: 6 });
    assert.equal(run.group.external, undefined, "external does not linger from the step before");
    assert.equal(run.group.step, "integration");
    assert.equal(run.group.stepRepo, undefined);
    assert.equal(run.group.failed, "the backend did not come up");
    run = reduce(run, { type: "group_fault", fault: "frontend", goals: { frontend: "fix" }, cost: 0.1, revised: true, t: 7 });
    run = reduce(run, { type: "group_plan", contract: "POST /orders v2", goals: { frontend: "fix" }, cost: 0, revised: true, t: 8 });
    assert.deepEqual(run.group.fault, { side: "frontend", goals: { frontend: "fix" } });
    assert.equal(run.group.contract, "POST /orders v2");
    assert.deepEqual(run.group.goals, { backend: "b", frontend: "f" }, "a revised contract keeps the plan's goals");
    run = reduce(run, {
      type: "group_end",
      ok: false,
      reason: "integration failed",
      parked: { backend: "orchestrator/failed-1", frontend: null },
      kept: { frontend: "orchestrator/group-checkpoint-1" },
      t: 9,
    });
    assert.deepEqual(run.group.kept, { frontend: "orchestrator/group-checkpoint-1" });
    assert.equal(run.status, "failed");
    assert.equal(run.endedAt, 9);
    assert.equal(run.error, "integration failed");
    assert.equal(run.group.ok, false);
    assert.deepEqual(run.group.parked, { backend: "orchestrator/failed-1", frontend: null });
    run = reduce(run, { type: "group_rollback", group: "shop", parked: { backend: "orchestrator/discarded-1" }, t: 10 });
    assert.equal(run.group.rolledBack, true);
    assert.deepEqual(run.group.rolledBackParked, { backend: "orchestrator/discarded-1" });
    const passed = reduce(fold([{ type: "group_start", group: "shop", goal: "g", repos }]), { type: "group_end", ok: true, t: 20 });
    assert.equal(passed.status, "passed");
    assert.equal(passed.group.ok, true);
    let landed = reduce(passed, {
      type: "group_branch",
      role: "backend",
      repo: "/be",
      branch: "orch/group-shop-g",
      base: "main",
      url: "https://x/pull/1",
      t: 21,
    });
    landed = reduce(landed, { type: "group_branch", role: "frontend", repo: "/fe", branch: "orch/group-shop-g", base: "main", error: "push failed", t: 22 });
    assert.deepEqual(landed.group.branches, {
      backend: { branch: "orch/group-shop-g", base: "main", url: "https://x/pull/1" },
      frontend: { branch: "orch/group-shop-g", base: "main", error: "push failed" },
    });
    assert.equal(reduce(null, { type: "group_plan", contract: "c", goals: {}, t: 1 }), null);
    let waiting = reduce(fold([{ type: "group_start", group: "shop", goal: "g", repos }]), {
      type: "group_approval_wait",
      round: 2,
      contract: "GET /items",
      goals: { backend: "b" },
      t: 21,
    });
    assert.deepEqual(waiting.group.approval, { round: 2, contract: "GET /items", goals: { backend: "b" } });
    waiting = reduce(waiting, { type: "group_approval", round: 2, action: "approve", t: 22 });
    assert.equal("approval" in waiting.group, false, "an answer clears the waiting plan");
    const plain = fold(start);
    for (const type of ["group_plan", "group_fault", "group_end", "group_step", "group_rollback", "group_approval_wait", "group_approval", "group_branch"])
      assert.equal(reduce(plain, { type, cost: 1, ok: true, t: 1 }), plain, `${type} leaves a run without a group alone`);
  });
});

describe("Agent M prefix rules (Always allow npm install …)", () => {
  test("offered for a plain command with more after two plain words", () => {
    assert.equal(o.prefixRule("npm install yaml"), "npm install");
    assert.equal(o.prefixRule("pip install requests==2.0"), "pip install");
    assert.equal(o.prefixRule("npx create-vite app"), "npx create-vite");
    assert.equal(o.prefixRule("npm install"), undefined, "nothing after the prefix");
    assert.equal(o.prefixRule("npm -g install x"), undefined, "a flag as the second word");
    assert.equal(o.prefixRule("npm install x && rm -rf ."), undefined);
    assert.equal(o.prefixRule("npm install x | tee log"), undefined);
    assert.equal(o.prefixRule("npm install $(cat list)"), undefined);
    assert.equal(o.prefixRule("npm install *.tgz"), undefined);
  });
  test("never for shells, interpreters, destructive commands or run-any-package subcommands", () => {
    for (const c of [
      "bash -c ls x",
      "node scripts/x.js arg",
      "python -m pip install x",
      "rm -rf dist",
      "curl https://x y",
      "git push origin x",
      "/usr/bin/sudo apt install x",
      "npm exec foo bar",
      "pnpm dlx foo bar",
    ])
      assert.equal(o.prefixRule(c), undefined, c);
  });
  test("a prefix rule covers the same tool and words only, never a chained command", () => {
    const rules = ["Bash(npm install:*)", "PowerShell(npm test)"];
    assert.equal(o.allowedBy(rules, "Bash", "npm install zod"), true);
    assert.equal(o.allowedBy(rules, "Bash", "npm installer x"), false);
    assert.equal(o.allowedBy(rules, "PowerShell", "npm install zod"), false);
    assert.equal(o.allowedBy(rules, "Bash", "npm install x; rm -rf ."), false);
    assert.equal(o.allowedBy(rules, "PowerShell", "npm test"), true);
  });
});

describe("pull requests on any git host (--pr)", () => {
  test("remote URLs become the repo's web address", () => {
    assert.equal(o.remoteWeb("https://github.com/me/app.git"), "https://github.com/me/app");
    assert.equal(o.remoteWeb("git@gitlab.com:group/sub/app.git"), "https://gitlab.com/group/sub/app");
    assert.equal(o.remoteWeb("ssh://git@codeberg.org:22/me/app.git"), "https://codeberg.org/me/app");
    assert.equal(o.remoteWeb("https://user@bitbucket.org/team/app.git/"), "https://bitbucket.org/team/app");
    assert.equal(o.remoteWeb("D:/repos/app.git"), undefined);
    assert.equal(o.remoteWeb("/srv/git/app.git"), undefined);
    assert.equal(o.remoteWeb("file:///srv/git/app.git"), undefined);
  });
  test("hosts", () => {
    assert.equal(o.forgeOf("https://github.com/me/app"), "github");
    assert.equal(o.forgeOf("https://github.corp.example/me/app"), "github");
    assert.equal(o.forgeOf("https://gitlab.example.org/me/app"), "gitlab");
    assert.equal(o.forgeOf("https://bitbucket.org/me/app"), "bitbucket");
    assert.equal(o.forgeOf("https://codeberg.org/me/app"), "gitea");
    assert.equal(o.forgeOf("https://forgejo.example.net/me/app"), "gitea");
    assert.equal(o.forgeOf("https://git.example.com/me/app"), "other");
    assert.equal(o.forgeOf(undefined), "other");
  });
  test("new pull request pages, and links printed on push", () => {
    assert.equal(o.newPullRequestUrl("https://git.example.com/me/app", "other", "main", "orch/1-x"), undefined);
    assert.equal(
      o.pushLink(
        "remote: \nremote: To create a merge request for orch/1-x, visit:\nremote:   https://gitlab.com/me/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=orch%2F1-x\n",
      ),
      "https://gitlab.com/me/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=orch%2F1-x",
    );
    assert.equal(
      o.pushLink("remote: Create pull request for orch/1-x:\nremote:   https://bitbucket.org/me/app/pull-requests/new?source=orch/1-x&t=1\n"),
      "https://bitbucket.org/me/app/pull-requests/new?source=orch/1-x&t=1",
    );
    assert.equal(
      o.pushLink("remote: Create a new pull request for 'orch/1-x':\nremote:   https://codeberg.org/me/app/compare/main...orch/1-x\n"),
      "https://codeberg.org/me/app/compare/main...orch/1-x",
    );
    assert.equal(o.pushLink("remote: Resolving deltas: 100%\nremote: see https://example.com/docs\n"), undefined);
    assert.equal(o.pushLink("To https://x/y.git\n * [new branch] orch/1-x -> orch/1-x\n"), undefined);
  });
});

describe("probe tool (orch run --probe)", () => {
  test("requests reach the backend's origin only, with a known method", () => {
    const base = "http://localhost:3999/api";
    assert.deepEqual(o.probeTarget(base, undefined, "/api/items?max=10"), { url: "http://localhost:3999/api/items?max=10", method: "GET" });
    assert.deepEqual(o.probeTarget(base, "post", "http://localhost:3999/x"), { url: "http://localhost:3999/x", method: "POST" });
    assert.match(o.probeTarget(base, "GET", "http://example.com/").error, /only the backend at http:\/\/localhost:3999/);
    assert.match(o.probeTarget(base, "GET", "http://localhost:4000/").error, /only the backend/, "another port is another origin");
    assert.match(o.probeTarget(base, "GET", "//evil.example/x").error, /only the backend/, "a protocol-relative path");
    assert.match(o.probeTarget(base, "TRACE", "/").error, /method must be one of/);
    assert.match(o.probeTarget(base, "GET", "").error, /path is required/);
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
  test("Agent M: only plain commands can be always-allowed (no wildcard, parentheses or secret in the rule)", () => {
    for (const ok of ["npm install zod", "npm run build -- --mode=prod", "git log -5"]) assert.equal(o.alwaysBlocked(ok), "", ok);
    assert.match(o.alwaysBlocked("ls *.ts"), /wildcard/);
    assert.match(o.alwaysBlocked("npm test:*"), /wildcard/);
    assert.match(o.alwaysBlocked("echo $(whoami)"), /parentheses/);
    assert.match(o.alwaysBlocked(`curl -H "key: ${"AKIA" + "ABCDEFGHIJKLMNOP"}" localhost`), /secret/);
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
    const { tsImport } = await tsxApi(root);
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

  test("detects web scripts without running them and rejects changed approvals", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-detect-"));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, "web"));
      mkdirSync(join(dir, "api"));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ scripts: { predev: "node prepare.js", dev: "vite --port 0" } }));
      writeFileSync(join(dir, "api", "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
      const apps = b.detectBrowserApps(dir);
      assert.equal(apps.length, 1);
      assert.equal(apps[0].directory, "web");
      assert.equal(apps[0].command, "pnpm run dev");
      assert.deepEqual(apps[0].lifecycle, ["predev: node prepare.js"]);
      process.chdir(dir);
      const cfg = { url: "auto", command: apps[0].command, auto: apps[0] };
      assert.deepEqual(b.parseServe(cfg), cfg);
      writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ scripts: { predev: "node changed.js", dev: "vite --port 0" } }));
      assert.throws(() => b.parseServe(cfg), /script changed/);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discovers a dev server's actual local URL and rediscovers it on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-server-"));
    const cwd = process.cwd();
    let server;
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node app.cjs vite" } }));
      writeFileSync(
        join(dir, "app.cjs"),
        `const http = require("node:http"); const s = http.createServer((_, r) => r.end("ok")); s.listen(0, "127.0.0.1", () => console.log("Local: http://127.0.0.1:" + s.address().port));`,
      );
      process.chdir(dir);
      const app = b.detectBrowserApps(dir)[0];
      server = new b.DevServer({ url: "auto", command: app.command, auto: app, timeout: 15 });
      assert.equal(await server.ensure(), null);
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(await (await fetch(server.url)).text(), "ok");
      assert.equal(await server.restart(), null);
      assert.equal(await (await fetch(server.url)).text(), "ok");
    } finally {
      server?.stop();
      process.chdir(cwd);
      // stop() does not wait for the exit, and Windows refuses to delete a live process's working directory (EPERM).
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
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

describe("gate checks", () => {
  test("loadGateChecks: none configured is empty, a valid map is kept", () => {
    assert.deepEqual(o.loadGateChecks({}), {});
    assert.deepEqual(o.loadGateChecks({ gateChecks: { perf: "node perf.js" } }), { perf: "node perf.js" });
  });
  test("loadGateChecks refuses anything but name: command strings", () => {
    for (const gateChecks of [["x"], { perf: 3 }, { "": "x" }, { perf: " " }, "node x"])
      assert.throws(() => o.loadGateChecks({ gateChecks }), /gateChecks/, JSON.stringify(gateChecks));
  });
  test("gateOverlap: a gate command that an ordinary check's allow rule would match", () => {
    assert.deepEqual(o.gateOverlap({ test: "node --test" }, { gate: "node --test ../g/x.test.js" }), ["gate"]);
    // checks.test also puts "npm test" on the allow list
    assert.deepEqual(o.gateOverlap({ test: "npm run test" }, { gate: "npm test -- --gate" }), ["gate"]);
    assert.deepEqual(o.gateOverlap({ lint: "npm run lint" }, { gate: "node ../g/run.mjs" }), []);
  });
  test("gateOverlap: the config's own allow rules (a user's, or Agent M's Always allow) count too", () => {
    assert.deepEqual(o.gateOverlap({}, { e2e: "make e2e" }, ["Bash(make:*)"]), ["e2e"]);
    assert.deepEqual(o.gateOverlap({}, { e2e: "make e2e" }, ["PowerShell(make e2e)"]), ["e2e"]);
    assert.deepEqual(o.gateOverlap({}, { e2e: "make e2e" }, ["Bash(make lint:*)", "Bash(make e2e-report)", "Read(**)"]), []);
  });
});

describe("failureDigest", () => {
  test("keeps every failing test's message from real node --test output, not only the last one", () => {
    const dir = mkdtempSync(join(tmpdir(), "yaaiorch-digest-"));
    try {
      const file = join(dir, "two.test.mjs");
      writeFileSync(
        file,
        `import { test } from "node:test";\nimport assert from "node:assert/strict";\n` +
          `test("first rule", () => assert.ok(false, "FIRST: exported functions need JSDoc\\n- src/a.js: f has no @param for x"));\n` +
          `test("second rule", () => assert.ok(false, "SECOND: error messages must start with the function name"));\n`,
      );
      // Without the parent runner's context, or the child skips its files as a recursive run.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env });
      assert.match(`${r.stdout}`, /second rule/, "precondition: the child ran the test file");
      const output = `${r.stdout}${r.stderr}`;
      assert.ok(!output.slice(-800).includes("FIRST"), "precondition: the old 800-character tail loses the first failure");
      const digest = o.failureDigest(output);
      assert.match(digest, /FIRST: exported functions need JSDoc/);
      assert.match(digest, /f has no @param for x/);
      assert.match(digest, /SECOND: error messages must start/);
      assert.doesNotMatch(digest, /^\s+at /m, "stack frames are dropped");
      assert.ok(digest.length <= 1500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a long failure does not push a short one out: each failing test gets its share", () => {
    const summary =
      "ℹ fail 2\n✖ failing tests:\n\ntest at gate.js:10:1\n✖ house rules: JSDoc (1ms)\n  AssertionError [ERR_ASSERTION]: SHORT: f has no @param for x\n\n" +
      `test at gate.js:20:1\n✖ house rules: error messages (2ms)\n  AssertionError [ERR_ASSERTION]: LONG: ${"- call threw x; must start with f: y\n".repeat(80)}`;
    const digest = o.failureDigest(summary);
    assert.match(digest, /SHORT: f has no @param for x/);
    assert.match(digest, /LONG: - call threw/);
    assert.ok(digest.length <= 1500, String(digest.length));
  });
  test("other output: the tail, stack frames dropped", () => {
    assert.equal(o.failureDigest("x".repeat(3000)).length, 1500);
    assert.equal(o.failureDigest("Error: boom\n    at f (a.js:1:2)\n    at g (b.js:3:4)\ndone"), "Error: boom\ndone");
  });
});

describe("event types (orch-events.ts)", () => {
  let ev;
  before(async () => {
    const { tsImport } = await tsxApi(root);
    ev = await tsImport(pathToFileURL(join(root, "orch-events.ts")).href, import.meta.url);
  });
  test("every event type is in CLAUDE.md's list and docs/ARCHITECTURE.md's table", () => {
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    const list = /With `ORCH_EVENTS=1`[^:]*:([^.]*)\./.exec(claude)?.[1] ?? "";
    const listed = new Set(list.split(",").map((s) => s.trim()));
    // The first cell of each table row; a row may name two events (`learn_start`, `learn_end`).
    const rows = readFileSync(join(root, "docs", "ARCHITECTURE.md"), "utf8").match(/^\| `[^|]*\|/gm) ?? [];
    const inTable = new Set(rows.flatMap((cell) => [...cell.matchAll(/`(\w+)`/g)].map((m) => m[1])));
    for (const type of ev.EVENT_TYPES) {
      assert.ok(listed.has(type), `CLAUDE.md's event list is missing ${type}`);
      assert.ok(inTable.has(type), `docs/ARCHITECTURE.md's event table is missing ${type}`);
    }
    for (const type of listed) assert.ok(ev.EVENT_TYPES.includes(type), `CLAUDE.md lists ${type}, which orch-events.ts does not define`);
  });
});
