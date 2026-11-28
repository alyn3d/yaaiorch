// Browser-mode server (orch-ui/server.ts): only the UI it serves may drive it.
// Starts the server on a free port with a scratch home folder; no repo, no agents, no tokens.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ui = join(root, "orch-ui");
const TSX = createRequire(join(ui, "package.json")).resolve("tsx/cli");

const freePort = () =>
  new Promise((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

let port, child, home;

/** A raw request, so the Host and Origin headers can be set freely (fetch forbids Host). */
const request = (path, { method = "GET", headers = {}, body, stream = false } = {}) =>
  new Promise((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      if (stream) {
        res.once("data", (chunk) => (ok({ status: res.statusCode, type: res.headers["content-type"], text: String(chunk) }), req.destroy()));
        if (res.statusCode !== 200) res.resume().on("end", () => ok({ status: res.statusCode }));
        return;
      }
      let text = "";
      res
        .setEncoding("utf8")
        .on("data", (d) => (text += d))
        .on("end", () => ok({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });

describe("browser-mode server guard", { timeout: 60_000 }, () => {
  before(async () => {
    port = await freePort();
    home = mkdtempSync(join(tmpdir(), "yaaiorch-server-"));
    child = spawn(process.execPath, [TSX, "server.ts"], {
      cwd: ui,
      env: { ...process.env, PORT: String(port), HOME: home, USERPROFILE: home, ORCH_REPO: "", ORCH_REPOS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("server did not start")), 30_000);
      child.stdout.on("data", (d) => String(d).includes(`localhost:${port}`) && (clearTimeout(t), ok()));
      child.on("exit", (c) => fail(new Error(`server exited ${c}`)));
    });
  });
  after(() => {
    child?.kill();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const token = async () => (await request("/api/token")).json().token;

  test("the UI's own origin gets the session token", async () => {
    const r = await request("/api/token", { headers: { origin: `http://localhost:${port}`, "sec-fetch-site": "same-origin" } });
    assert.equal(r.status, 200);
    assert.match(r.json().token, /^[0-9a-f]{64}$/);
  });

  test("other sites and DNS rebinding are refused, even for the token", async () => {
    assert.equal((await request("/api/token", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await request("/api/token", { headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await request("/api/token", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await request("/", { headers: { host: `evil.example:${port}` } })).status, 403);
  });

  test("API calls need the token; a cross-site POST with it is still refused", async () => {
    const t = await token();
    const settings = (headers) =>
      request("/api/settings", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: { maxParallel: 3 } });
    assert.equal((await settings({})).status, 403, "no token");
    assert.equal((await settings({ "x-orch-token": "0".repeat(64) })).status, 403, "wrong token");
    assert.equal((await settings({ "x-orch-token": t, origin: "https://evil.example" })).status, 403, "foreign origin");
    // A plain HTML form post (text/plain, no custom header) from another site.
    assert.equal(
      (await request("/api/run", { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example" }, body: "x" })).status,
      403,
    );
    const ok = await settings({ "x-orch-token": t, origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await request("/api/state")).status, 403, "reads need it too");
    assert.equal((await request("/api/state", { headers: { "x-orch-token": t } })).json().maxParallel, 3);
  });

  test("the event stream takes the token in the URL", async () => {
    assert.equal((await request("/api/events", { stream: true })).status, 403);
    const r = await request(`/api/events?token=${await token()}`, { stream: true });
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/event-stream/);
    assert.match(r.text, /^event: init/);
  });

  test("the agent roster lists discovered agents and saves project-local overrides", async () => {
    const repo = join(home, "repo");
    mkdirSync(repo);
    const t = await token();
    const opened = await request("/api/add-repo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orch-token": t },
      body: { path: repo },
    });
    assert.equal(opened.status, 200, opened.text);

    const roster = await request(`/api/agents?repo=${encodeURIComponent(repo)}`, { headers: { "x-orch-token": t } });
    assert.equal(roster.status, 200, roster.text);
    assert.ok(roster.json().agents.some((a) => a.name === "architect" && a.source === "builtin" && a.builtin));
    assert.deepEqual(roster.json().skills, []);

    const content = "---\nname: helper\ndescription: A project helper\n---\n\nDo the work.\n";
    const saved = await request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orch-token": t },
      body: { repo, name: "helper", content },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(readFileSync(join(repo, ".claude", "agents", "helper.md"), "utf8"), content);
    const updated = await request(`/api/agents?repo=${encodeURIComponent(repo)}`, { headers: { "x-orch-token": t } });
    const helper = updated.json().agents.find((a) => a.name === "helper");
    assert.equal(helper?.source, "project");
    assert.equal(helper?.content, content);

    const swapped = await request("/api/agents/swap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orch-token": t },
      body: { repo, role: "be", target: "helper" },
    });
    assert.equal(swapped.status, 200, swapped.text);
    const rosterWithSwap = await request(`/api/agents?repo=${encodeURIComponent(repo)}`, { headers: { "x-orch-token": t } });
    assert.equal(rosterWithSwap.json().swap.be, "helper");
    const unswapped = await request("/api/agents/swap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orch-token": t },
      body: { repo, role: "be" },
    });
    assert.equal(unswapped.status, 200, unswapped.text);
    assert.deepEqual((await request(`/api/agents?repo=${encodeURIComponent(repo)}`, { headers: { "x-orch-token": t } })).json().swap, {});
  });

  test("browser setup is token-protected, scoped to an open repo and requires a detected selection", async () => {
    const repo = join(home, "browser-repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const t = await token();
    const headers = { "x-orch-token": t, "content-type": "application/json" };
    assert.equal((await request("/api/add-repo", { method: "POST", headers, body: { path: repo } })).status, 200);
    const path = `/api/browser?repo=${encodeURIComponent(repo)}`;
    assert.equal((await request(path)).status, 403);
    const detected = await request(path, { headers });
    assert.equal(detected.status, 200, detected.text);
    const [candidate] = detected.json().candidates;
    assert.ok(candidate);
    assert.notEqual((await request(`/api/browser?repo=${encodeURIComponent(join(home, "not-open"))}`, { headers })).status, 200);
    assert.equal((await request("/api/browser", { method: "POST", headers, body: { repo, action: "enable", id: "invalid" } })).status, 400);
    const enabled = await request("/api/browser", { method: "POST", headers, body: { repo, action: "enable", id: candidate.id } });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal((await request(path, { headers })).json().enabled, true);
    const disabled = await request("/api/browser", { method: "POST", headers, body: { repo, action: "disable" } });
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal((await request(path, { headers })).json().enabled, false);
  });

  test("history is scoped to an open repo and requires the API token", async () => {
    const repo = join(home, "history-repo");
    const runs = join(repo, ".orchestrator", "runs");
    mkdirSync(runs, { recursive: true });
    const id = "1700000000000-12345678-1234-1234-1234-123456789abc";
    const events = [
      { type: "goal_start", t: 1700000000000, goal: "saved goal", maxRounds: 2, dryRun: false },
      { type: "goal_end", t: 1700000001000, passed: true, cost: 0.5 },
    ];
    writeFileSync(join(runs, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const t = await token();
    const headers = { "x-orch-token": t };
    const opened = await request("/api/add-repo", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: { path: repo },
    });
    assert.equal(opened.status, 200, opened.text);
    const path = `/api/history?repo=${encodeURIComponent(repo)}`;
    assert.equal((await request(path)).status, 403);
    const list = await request(path, { headers });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(
      list.json().map((entry) => [entry.id, entry.goal, entry.status]),
      [[id, "saved goal", "passed"]],
    );
    const replay = await request(`${path}&id=${id}`, { headers });
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.json(), { events, truncated: false });
    assert.notEqual((await request(`${path}&id=${encodeURIComponent("../queue")}`, { headers })).status, 200);
    assert.notEqual((await request(`/api/history?repo=${encodeURIComponent(join(home, "not-open"))}`, { headers })).status, 200);
  });

  test("screenshots are token-protected and confined to the open repo's visual directory", async () => {
    const repo = join(home, "visual-repo");
    const visualDir = join(repo, ".orchestrator", "visual", "round-1");
    mkdirSync(visualDir, { recursive: true });
    writeFileSync(join(visualDir, "shot.png"), "png-data");
    const t = await token();
    const headers = { "x-orch-token": t };
    const opened = await request("/api/add-repo", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: { path: repo },
    });
    assert.equal(opened.status, 200, opened.text);

    const path = `/api/visual?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(".orchestrator/visual/round-1/shot.png")}`;
    assert.equal((await request(path)).status, 403);
    const image = await request(path, { headers, stream: true });
    assert.equal(image.status, 200, image.text);
    assert.equal(image.type, "image/png");
    assert.equal(image.text, "png-data");
    const traversal = `/api/visual?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(".orchestrator/visual/../../outside.png")}`;
    assert.equal((await request(traversal, { headers })).status, 400);
    assert.notEqual(
      (await request(`/api/visual?repo=${encodeURIComponent(join(home, "not-open"))}&file=${encodeURIComponent(".orchestrator/visual/shot.png")}`, { headers }))
        .status,
      200,
    );
  });
});

// A group process (`orch group run`) prints its own events and wraps each member's in group_child: the member's
// events land in that repo's session, and every cost is counted once toward the daily budget.
describe("browser-mode server: group events", { timeout: 60_000 }, () => {
  let group, member;
  before(async () => {
    port = await freePort();
    home = mkdtempSync(join(tmpdir(), "yaaiorch-server-group-"));
    group = join(home, "group-repo");
    member = join(home, "member-repo");
    mkdirSync(group);
    mkdirSync(member);
    // The fake orch writes its events and exits; on Windows the member's path comes back in another case and with forward slashes.
    const fakeOrch = join(home, "fake-orch.mjs");
    const named = process.platform === "win32" ? member.toUpperCase().replaceAll("\\", "/") : member;
    const events = [
      { type: "group_start", group: "shop", goal: "checkout", repos: [{ path: named, role: "backend" }] },
      { type: "group_plan", contract: "POST /orders", goals: { backend: "b" }, cost: 0.25 },
      { type: "group_child", repo: named, role: "backend", event: { type: "goal_start", goal: "b", maxRounds: 1, t: 1 } },
      { type: "group_child", repo: named, role: "backend", event: { type: "task_end", round: 1, id: 0, status: "COMPLETE", cost: 0.5, t: 2 } },
      {
        type: "group_child",
        repo: join(home, "not-open"),
        role: "frontend",
        event: { type: "task_end", round: 1, id: 0, status: "COMPLETE", cost: 0.125, t: 3 },
      },
      { type: "group_fault", fault: "backend", goals: { backend: "fix" }, cost: 0.0625 },
      { type: "group_end", ok: true },
    ];
    // A run whose goal is "hold" prints nothing and stays up until stopped: the member's own live run.
    const prints = events.map((e) => `console.log(${JSON.stringify("@@ORCH@@ " + JSON.stringify({ t: 1, ...e }))});`).join("\n");
    writeFileSync(fakeOrch, `if (process.argv.at(-1) === "hold") setInterval(() => {}, 1000);\nelse {\n${prints}\n}\n`);
    child = spawn(process.execPath, [TSX, "server.ts"], {
      cwd: ui,
      env: { ...process.env, PORT: String(port), HOME: home, USERPROFILE: home, ORCH_REPO: "", ORCH_REPOS: "", ORCH_PATH: fakeOrch },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("server did not start")), 30_000);
      child.stdout.on("data", (d) => String(d).includes(`localhost:${port}`) && (clearTimeout(t), ok()));
      child.on("exit", (c) => fail(new Error(`server exited ${c}`)));
    });
  });
  after(async () => {
    // A failed assertion must not leave the member's held run behind.
    if (headers) await request("/api/stop", { method: "POST", headers, body: { repo: member } }).catch(() => {});
    child?.kill();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  let headers;
  const stateOf = async () => (await request("/api/state", { headers })).json();
  /** Until `repo`'s session matches `done`; the last state. */
  const until = async (repo, done) => {
    let state;
    for (let i = 0; i < 200; i++) {
      state = await stateOf();
      if (done(state.sessions.find((s) => s.state.repo === repo))) return state;
      await new Promise((r) => setTimeout(r, 100));
    }
    return state;
  };
  const exits = (s) => s.log.filter((l) => l.startsWith("-- exited")).length;

  test("a wrapped child's cost counts once and its events go to the member repo's session", async () => {
    headers = { "x-orch-token": (await request("/api/token")).json().token, "content-type": "application/json" };
    for (const path of [group, member]) assert.equal((await request("/api/add-repo", { method: "POST", headers, body: { path } })).status, 200);
    const started = await request("/api/run", { method: "POST", headers, body: { repo: group, goal: "checkout" } });
    assert.equal(started.status, 200, started.text);
    const state = await until(group, (g) => !g.state.running && exits(g) === 1);
    assert.equal(state.global.budget.spent, 0.9375, "plan 0.25 + child task 0.5 + unmatched child task 0.125 + fault 0.0625");
    const types = (repo) => state.sessions.find((s) => s.state.repo === repo).events.map((e) => e.type);
    assert.deepEqual(types(member), ["goal_start", "task_end"]);
    assert.deepEqual(types(group), ["group_start", "group_plan", "group_child", "group_fault", "group_end"]);
    const unmatched = state.sessions.find((s) => s.state.repo === group).events.find((e) => e.type === "group_child");
    assert.equal(unmatched.event.cost, 0.125, "a child of a repo that is not open stays with the group's session");
  });

  test("a member session with its own live run keeps the group's events apart; they still count once", async () => {
    const held = await request("/api/run", { method: "POST", headers, body: { repo: member, goal: "hold" } });
    assert.equal(held.status, 200, held.text);
    await until(member, (m) => m.state.running);
    const before = (await stateOf()).sessions.find((s) => s.state.repo === member).events;
    assert.equal((await request("/api/run", { method: "POST", headers, body: { repo: group, goal: "checkout" } })).status, 200);
    const state = await until(group, (g) => !g.state.running && exits(g) === 2);
    assert.equal(state.global.budget.spent, 1.875, "both group runs, each counted once");
    const sessionOf = (repo) => state.sessions.find((s) => s.state.repo === repo);
    assert.deepEqual(sessionOf(member).events, before, "the member's own run sees none of the group's events");
    assert.ok(sessionOf(member).state.running, "the member's own run is untouched");
    assert.deepEqual(
      sessionOf(group).events.map((e) => e.type),
      ["group_start", "group_plan", "group_child", "group_child", "group_child", "group_fault", "group_end"],
    );
    assert.equal((await request("/api/stop", { method: "POST", headers, body: { repo: member } })).status, 200);
    await until(member, (m) => !m.state.running);
  });
});

// Claude profiles: a repo assigned to a profile runs orch with that profile's CLAUDE_CONFIG_DIR; a group's repos must share one.
describe("browser-mode server: Claude profiles", { timeout: 60_000 }, () => {
  let a, b, calls, headers, gdir;
  before(async () => {
    port = await freePort();
    home = mkdtempSync(join(tmpdir(), "yaaiorch-server-profiles-"));
    a = join(home, "work-repo");
    b = join(home, "home-repo");
    gdir = join(home, "groups", "pair");
    calls = join(home, "calls.txt");
    mkdirSync(a);
    mkdirSync(b);
    const fakeOrch = join(home, "fake-orch.mjs");
    const list = [
      {
        name: "pair",
        dir: gdir,
        repos: [
          { path: a, role: "backend" },
          { path: b, role: "frontend" },
        ],
      },
    ];
    // Logs each call with the CLAUDE_CONFIG_DIR it got and exits at once. `account --login` logs a profile folder in
    // (a marker file), `account --json` reports it.
    writeFileSync(
      fakeOrch,
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR ?? null;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd(), dir, chatDir: process.env.ORCH_CHAT_DIR ?? null }) + String.fromCharCode(10));
if (args[0] === "group" && args[1] === "list") console.log(${JSON.stringify(JSON.stringify(list))});
// A run whose goal is "limit" hits the usage limit (resets in an hour); "spend" costs $2.
const ev = (e) => console.log("@@ORCH@@ " + JSON.stringify({ t: 1, ...e }));
if (args[0] === "run" && args.includes("limit")) ev({ type: "usage_limit", resetAt: Date.now() + 3600000 });
if (args[0] === "run" && args.includes("spend")) ev({ type: "task_end", round: 1, id: 0, status: "COMPLETE", cost: 2 });
if (args[0] === "chat" && !args.includes("--warm")) console.log(JSON.stringify({ answer: "hi", session: "s1", cost: 0.5 }));
if (args[0] === "account") {
  if (args.includes("--login") && dir) writeFileSync(join(dir, "in"), "1");
  const loggedIn = !dir || existsSync(join(dir, "in"));
  console.log(JSON.stringify({ loggedIn, ...(loggedIn ? { email: dir ? "me@work.example" : "me@home.example" } : {}), configDir: dir ?? "default" }));
}
`,
    );
    const env = {
      ...process.env,
      PORT: String(port),
      HOME: home,
      USERPROFILE: home,
      ORCH_REPO: "",
      ORCH_REPOS: "",
      ORCH_PATH: fakeOrch,
      YAAIORCH_LOGIN_POLL_MS: "100",
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.YAAIORCH_HOME;
    child = spawn(process.execPath, [TSX, "server.ts"], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("server did not start")), 30_000);
      child.stdout.on("data", (d) => String(d).includes(`localhost:${port}`) && (clearTimeout(t), ok()));
      child.on("exit", (c) => fail(new Error(`server exited ${c}`)));
    });
    headers = { "x-orch-token": (await request("/api/token")).json().token, "content-type": "application/json" };
  });
  after(() => {
    child?.kill();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const post = (path, body) => request(`/api/${path}`, { method: "POST", headers, body });
  const stateOf = async () => (await request("/api/state", { headers })).json();
  const called = () =>
    readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  /** The CLAUDE_CONFIG_DIR of the latest `run` call in `repo`, once it has been made. */
  const runDir = async (repo, n) => {
    for (let i = 0; i < 200; i++) {
      const runs = existsSync(calls) ? called().filter((c) => c.args[0] === "run" && resolve(c.cwd) === resolve(repo)) : [];
      if (runs.length >= n) return runs[n - 1].dir;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no run ${n} in ${repo}`);
  };
  const idle = async (repo) => {
    for (let i = 0; i < 200; i++) {
      if (!(await stateOf()).sessions.find((s) => s.state.repo === repo)?.state.running) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  test("profiles are checked, get a folder of their own, and are remembered", async () => {
    for (const bad of [[{ id: "Work" }], [{ id: "w" }, { id: "w" }], [{ id: "w", configDir: "relative/dir" }], "nope"]) {
      const r = await post("profiles", { profiles: bad });
      assert.equal(r.status, 500, JSON.stringify(bad));
    }
    const r = await post("profiles", { profiles: [{ id: "work", name: "Work" }] });
    assert.equal(r.status, 200, r.text);
    const dir = join(home, ".yaaiorch", "profiles", "work", "claude");
    assert.deepEqual(r.json().profiles, [{ id: "work", name: "Work", configDir: dir }]);
    assert.ok(existsSync(dir), "the profile's Claude folder is created");
    assert.deepEqual((await stateOf()).profiles, r.json().profiles);
  });

  test("a repo's runs get its profile's CLAUDE_CONFIG_DIR; the default gets none", async () => {
    for (const path of [a, b]) assert.equal((await post("add-repo", { path })).status, 200);
    assert.equal((await post("repo-profile", { repo: a, profile: "nope" })).status, 400);
    assert.equal((await post("repo-profile", { repo: a, profile: "work" })).status, 200);
    const state = await stateOf();
    assert.equal(state.sessions.find((s) => s.state.repo === a).state.profile, "work");
    const saved = JSON.parse(readFileSync(join(home, ".yaaiorch", "ui.json"), "utf8"));
    assert.deepEqual(Object.values(saved.repoProfiles), ["work"]);

    assert.equal((await post("run", { repo: a, goal: "x" })).status, 200);
    assert.equal(await runDir(a, 1), join(home, ".yaaiorch", "profiles", "work", "claude"));
    assert.equal((await post("run", { repo: b, goal: "x" })).status, 200);
    assert.equal(await runDir(b, 1), null);

    await idle(a);
    assert.equal((await post("repo-profile", { repo: a, profile: null })).status, 200);
    assert.equal((await post("run", { repo: a, goal: "x" })).status, 200);
    assert.equal(await runDir(a, 2), null, "back on the default account");
    await idle(a);
  });

  test("a group whose repos use different profiles is refused", async () => {
    assert.equal((await post("repo-profile", { repo: a, profile: "work" })).status, 200);
    for (let i = 0; i < 100 && !(await stateOf()).sessions.some((s) => s.state.repo === gdir); i++) await new Promise((r) => setTimeout(r, 100));
    const r = await post("run", { repo: gdir, goal: "both" });
    assert.equal(r.status, 500);
    assert.match(r.json().error, /different Claude profiles \(work, default\)/);
  });

  test("login status per profile; a login opens for that profile's folder and is watched until it lands", async () => {
    const status = async () => (await post("profile-status", {})).json();
    const work = join(home, ".yaaiorch", "profiles", "work", "claude");
    assert.deepEqual(await status(), [
      { id: null, loggedIn: true, email: "me@home.example", configDir: "default", pending: false },
      { id: "work", loggedIn: false, configDir: work, pending: false },
    ]);
    assert.equal((await post("profile-login", { profile: "nope" })).status, 400);
    const r = await post("profile-login", { profile: "work" });
    assert.equal(r.status, 200, r.text);
    const login = called().find((c) => c.args[0] === "account" && c.args.includes("--login"));
    assert.equal(login.dir, work, "the login runs for the profile's folder");
    let list;
    for (let i = 0; i < 100; i++) {
      list = await status();
      if (list[1].loggedIn && !list[1].pending) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(list[1], { id: "work", loggedIn: true, email: "me@work.example", configDir: work, pending: false });
  });

  test("a usage limit or a used-up budget holds only its own account's repos", async () => {
    // a is on "work", b on the default account (from the tests above).
    const runs = (repo) => called().filter((c) => c.args[0] === "run" && resolve(c.cwd) === resolve(repo));
    const sessionOf = async (repo) => (await stateOf()).sessions.find((s) => s.state.repo === repo).state;
    const waitFor = async (cond) => {
      for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(await cond());
    };
    const before = { a: runs(a).length, b: runs(b).length };

    assert.equal((await post("run", { repo: a, goal: "limit" })).status, 200);
    await waitFor(async () => (await stateOf()).global.accounts?.work?.usageLimit);
    await idle(a);
    let g = (await stateOf()).global;
    assert.equal(g.usageLimit, null, "the default account is not held");
    assert.equal(g.accounts[""].usageLimit, null);

    assert.equal((await post("run", { repo: b, goal: "x" })).status, 200);
    await waitFor(async () => runs(b).length === before.b + 1);
    await idle(b);
    assert.equal((await post("run", { repo: a, goal: "x" })).status, 200);
    assert.match((await sessionOf(a)).waitReason, /usage limit/);
    assert.equal(runs(a).length, before.a + 1, "the held start waits");

    // "Try now" for another account leaves this one held; for this one, the start goes.
    assert.equal((await post("clear-limit", { profile: "" })).status, 200);
    assert.ok((await sessionOf(a)).queued);
    assert.equal((await post("clear-limit", { profile: "work" })).status, 200);
    await waitFor(async () => runs(a).length === before.a + 2);
    await idle(a);

    // A budget on the work profile: its spending holds it, the default account runs on.
    assert.equal((await post("profiles", { profiles: [{ id: "work", name: "Work", dailyBudget: 1 }] })).status, 200);
    assert.equal((await post("run", { repo: a, goal: "spend" })).status, 200);
    await waitFor(async () => (await stateOf()).global.accounts.work.budget.spent === 2);
    await idle(a);
    g = (await stateOf()).global;
    assert.deepEqual(g.accounts.work.budget, { limit: 1, spent: 2, day: g.budget.day });
    assert.equal(g.budget.spent, 0, "the default account spent nothing");
    assert.equal(JSON.parse(readFileSync(join(home, ".yaaiorch", "ui.json"), "utf8")).spent.profiles.work, 2);
    assert.equal((await post("run", { repo: a, goal: "x" })).status, 200);
    assert.match((await sessionOf(a)).waitReason, /daily budget of \$1 used up/);
    assert.equal((await post("run", { repo: b, goal: "x" })).status, 200);
    await waitFor(async () => runs(b).length === before.b + 2);
    assert.ok(!runs(b).at(-1).args.includes("--max-cost"), "the default account has no budget");
    await idle(b);

    // Raised: the waiting start goes, with what is left of the work budget as its cap.
    assert.equal((await post("profiles", { profiles: [{ id: "work", name: "Work", dailyBudget: 5 }] })).status, 200);
    await waitFor(async () => runs(a).length === before.a + 4);
    const args = runs(a).at(-1).args;
    assert.equal(args[args.indexOf("--max-cost") + 1], "3.00");
    await idle(a);
  });

  test("Agent M runs on the chosen account, in a chat folder of its own, and its cost counts there", async () => {
    const chats = () => called().filter((c) => c.args[0] === "chat");
    const spentOn = async (key) => (await stateOf()).global.accounts[key].budget.spent;
    const before = { work: await spentOn("work"), def: await spentOn("") };
    assert.equal((await post("agent-m/ask", { question: "hi", profile: "nope" })).status, 500);
    const r = await post("agent-m/ask", { question: "hi", profile: "work" });
    assert.equal(r.status, 200, r.text);
    const ask = chats()
      .filter((c) => !c.args.includes("--warm"))
      .at(-1);
    assert.equal(ask.dir, join(home, ".yaaiorch", "profiles", "work", "claude"));
    assert.equal(ask.chatDir, `${join(home, ".yaaiorch", "agent-m")}-work`);
    assert.equal(await spentOn("work"), before.work + 0.5);
    assert.equal(await spentOn(""), before.def);

    assert.equal((await post("agent-m/ask", { question: "hi" })).status, 200);
    const plain = chats()
      .filter((c) => !c.args.includes("--warm"))
      .at(-1);
    assert.equal(plain.dir, null, "the default account");
    assert.equal(plain.chatDir, null, "the default chat folder");
    assert.equal(await spentOn(""), before.def + 0.5);

    assert.equal((await post("agent-m/warm", { profile: "work" })).status, 200);
    for (let i = 0; i < 50 && !chats().some((c) => c.args.includes("--warm") && c.dir); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(chats().some((c) => c.args.includes("--warm") && c.chatDir === `${join(home, ".yaaiorch", "agent-m")}-work`));
  });

  test("a group's session carries its members' profiles, refreshed when one changes", async () => {
    const group = async () => (await stateOf()).sessions.find((s) => s.state.repo === gdir).state;
    assert.deepEqual((await group()).memberProfiles, ["work", null]);
    assert.equal((await post("repo-profile", { repo: b, profile: "work" })).status, 200);
    assert.deepEqual((await group()).memberProfiles, ["work", "work"]);
  });
});

// Repo groups as sessions: the server lists groups through `orch group list --json` and keys each by its run dir. While
// a group runs, its members report `inGroup` and refuse their own starts; Stop asks `orch group stop` instead of killing.
describe("browser-mode server: group sessions", { timeout: 60_000 }, () => {
  let be, fe, gdir, calls, headers;
  before(async () => {
    port = await freePort();
    home = mkdtempSync(join(tmpdir(), "yaaiorch-server-gsess-"));
    be = join(home, "api");
    fe = join(home, "web");
    gdir = join(home, "groups", "shop");
    calls = join(home, "calls.txt");
    mkdirSync(be);
    mkdirSync(fe);
    const fakeOrch = join(home, "fake-orch.mjs");
    const list = [
      {
        name: "shop",
        dir: gdir,
        repos: [
          { path: be, role: "backend" },
          { path: fe, role: "frontend" },
        ],
      },
    ];
    // Every call is logged; `group run` holds until `group stop` writes the stop file, then ends like a stopped group.
    writeFileSync(
      fakeOrch,
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + String.fromCharCode(10));
const stop = ${JSON.stringify(join(home, "stop"))};
if (args[0] === "group" && args[1] === "list") console.log(${JSON.stringify(JSON.stringify(list))});
else if (args[0] === "group" && args[1] === "stop") writeFileSync(stop, "1");
else if (args[0] === "group" && args[1] === "run") {
  console.log("@@ORCH@@ " + JSON.stringify({ type: "group_start", t: 1, group: "shop", goal: args.at(-1), repos: [] }));
  const t = setInterval(() => {
    if (!existsSync(stop)) return;
    clearInterval(t);
    console.log("@@ORCH@@ " + JSON.stringify({ type: "group_end", t: 2, ok: false, reason: "Stopped" }));
    process.exit(130);
  }, 100);
}
`,
    );
    child = spawn(process.execPath, [TSX, "server.ts"], {
      cwd: ui,
      env: { ...process.env, PORT: String(port), HOME: home, USERPROFILE: home, ORCH_REPO: "", ORCH_REPOS: "", ORCH_PATH: fakeOrch },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("server did not start")), 30_000);
      child.stdout.on("data", (d) => String(d).includes(`localhost:${port}`) && (clearTimeout(t), ok()));
      child.on("exit", (c) => fail(new Error(`server exited ${c}`)));
    });
    headers = { "x-orch-token": (await request("/api/token")).json().token, "content-type": "application/json" };
  });
  after(async () => {
    writeFileSync(join(home, "stop"), "1");
    await new Promise((r) => setTimeout(r, 300));
    child?.kill();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const stateOf = async () => (await request("/api/state", { headers })).json();
  const sessionOf = (state, repo) => state.sessions.find((s) => s.state.repo === repo);
  const until = async (done) => {
    let state;
    for (let i = 0; i < 200; i++) {
      state = await stateOf();
      if (done(state)) return state;
      await new Promise((r) => setTimeout(r, 100));
    }
    return state;
  };
  const called = () =>
    readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const post = (path, body) => request(`/api/${path}`, { method: "POST", headers, body });

  test("a group gets a session keyed by its run dir, not remembered as a repo", async () => {
    const state = await until((s) => sessionOf(s, gdir));
    assert.equal(sessionOf(state, gdir).state.group.name, "shop");
    assert.equal(JSON.parse(readFileSync(join(home, ".yaaiorch", "ui.json"), "utf8")).repos.length, 0);
    assert.equal((await post("loop", { repo: gdir })).status, 400, "a group has no queue");
  });

  test("the form becomes orch group add, checked first", async () => {
    const bad = await post("group-save", { name: "Shop", backend: be, frontend: fe });
    assert.equal(bad.status, 500);
    assert.match(bad.text, /group name/);
    const ok = await post("group-save", { name: "shop", backend: be, frontend: fe, serveUrl: "http://localhost:3999", env: { API_URL: "{backend}" } });
    assert.equal(ok.status, 200, ok.text);
    const add = called().find((a) => a[1] === "add");
    assert.deepEqual(add, [
      "group",
      "add",
      "shop",
      "--repo",
      `${be}:backend`,
      "--repo",
      `${fe}:frontend`,
      "--serve-url",
      "http://localhost:3999",
      "--env",
      "API_URL={backend}",
    ]);
  });

  test("a run opens the members, marks them busy, refuses their starts, and Stop asks the group", async () => {
    const started = await post("run", { repo: gdir, goal: "checkout", power: "economy", maxRounds: 2, approvePlan: true });
    assert.equal(started.status, 200, started.text);
    let state = await until((s) => sessionOf(s, gdir)?.state.running && sessionOf(s, be)?.state.inGroup);
    assert.equal(sessionOf(state, be).state.inGroup, "shop");
    assert.equal(sessionOf(state, fe).state.inGroup, "shop");
    await until(() => called().some((a) => a[1] === "run"));
    assert.deepEqual(
      called().find((a) => a[1] === "run"),
      ["group", "run", "--keep-awake", "shop", "--power", "economy", "--max-rounds", "2", "--approve-plan", "checkout"],
    );
    const own = await post("run", { repo: be, goal: "x" });
    assert.equal(own.status, 500);
    assert.match(own.json().error, /busy in group "shop"/);
    assert.equal((await post("remove-repo", { repo: fe })).status, 409);
    assert.equal((await post("group-remove", { name: "shop" })).status, 409);
    assert.equal((await post("stop", { repo: gdir })).status, 200);
    state = await until((s) => !sessionOf(s, gdir).state.running);
    assert.ok(
      called().some((a) => a[1] === "stop" && a[2] === "shop"),
      "stopped through orch group stop",
    );
    assert.deepEqual(
      sessionOf(state, gdir).events.map((e) => e.type),
      ["group_start", "group_end"],
      "the group ended on its own, after parking",
    );
    assert.equal(sessionOf(state, be).state.inGroup, undefined);
  });

  test("approve and rollback name the group", async () => {
    await post("approve", { repo: gdir, reject: "smaller" });
    assert.deepEqual(
      called().find((a) => a[0] === "approve"),
      ["approve", "--reject", "smaller", "--group", "shop"],
    );
    assert.equal((await post("rollback", { repo: gdir })).status, 200);
    await until(() => called().some((a) => a[1] === "rollback"));
    assert.deepEqual(
      called().find((a) => a[1] === "rollback"),
      ["group", "rollback", "shop"],
    );
  });
});

describe("desktop app mode (the app starts this server as its backend)", { timeout: 60_000 }, () => {
  let app, parent, dir, token;
  const APP = "http://tauri.localhost";
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "yaaiorch-app-"));
    // Stands in for the app: the server exits once this process is gone.
    parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    app = spawn(process.execPath, [TSX, "server.ts"], {
      cwd: ui,
      env: {
        ...process.env,
        PORT: "0",
        HOME: dir,
        USERPROFILE: dir,
        ORCH_REPO: "",
        ORCH_REPOS: "",
        YAAIORCH_APP: "1",
        YAAIORCH_APP_ORIGINS: `tauri://localhost,${APP}`,
        YAAIORCH_UI_SETTINGS: join(dir, "repos.json"),
        YAAIORCH_PARENT_PID: String(parent.pid),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("no ready line")), 30_000);
      let out = "";
      app.stdout.on("data", (d) => {
        out += d;
        const m = /@@READY@@ (\{.*\})/.exec(out);
        if (!m) return;
        clearTimeout(t);
        ok(JSON.parse(m[1]));
      });
      app.on("exit", (c) => fail(new Error(`server exited ${c}`)));
    });
    port = ready.port;
    token = ready.token;
  });
  after(() => {
    app?.kill();
    parent?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("prints its port and token once listening; never hands the token out over HTTP", async () => {
    assert.ok(port > 0);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await request("/api/token", { headers: { origin: `http://localhost:${port}`, "sec-fetch-site": "same-origin" } })).status, 403);
  });

  test("the app's origin may call it with the token (CORS), another origin may not", async () => {
    const pre = await request("/api/settings", { method: "OPTIONS", headers: { origin: APP, "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    const ok = await request("/api/settings", {
      method: "POST",
      headers: { origin: APP, "x-orch-token": token, "content-type": "application/json" },
      body: { keepAwake: false },
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(JSON.parse(readFileSync(join(dir, "repos.json"), "utf8")).keepAwake, false, "settings go to the app's file");
    const seen = await new Promise((ok) =>
      http.get({ host: "127.0.0.1", port, path: "/api/state", headers: { origin: "tauri://localhost", "x-orch-token": token } }, (res) => {
        res.resume();
        ok(res.headers["access-control-allow-origin"]);
      }),
    );
    assert.equal(seen, "tauri://localhost");
    assert.equal((await request("/api/state", { headers: { origin: "https://evil.example", "x-orch-token": token } })).status, 403);
    const foreignPre = await request("/api/settings", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(foreignPre.status, 403, "no preflight for other origins");
  });

  test("exits when the app is gone", async () => {
    const exited = new Promise((ok) => app.once("exit", ok));
    parent.kill();
    await Promise.race([exited, new Promise((_, fail) => setTimeout(() => fail(new Error("still running")), 15_000))]);
  });
});

describe("remote access through the tunnel (fake cloudflared)", { timeout: 60_000 }, () => {
  let srv, dir, token;
  const HOST = "test-tunnel.trycloudflare.com";
  const ORIGIN = `https://${HOST}`;
  /** A request as cloudflared forwards it: the tunnel's host and Cloudflare's headers. */
  const remoteReq = (path, { method = "GET", cookie, body, origin = ORIGIN, ip = "203.0.113.7" } = {}) =>
    request(path, {
      method,
      body,
      headers: {
        host: HOST,
        "cf-connecting-ip": ip,
        "cf-ray": "abc",
        ...(method === "GET" ? {} : { origin, "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
    });
  const pc = (path, b) =>
    request(
      path,
      b === undefined
        ? { headers: { "x-orch-token": token } }
        : { method: "POST", headers: { "x-orch-token": token, "content-type": "application/json" }, body: b },
    );

  before(async () => {
    port = await freePort();
    dir = mkdtempSync(join(tmpdir(), "yaaiorch-remote-srv-"));
    srv = spawn(process.execPath, [TSX, "server.ts"], {
      cwd: ui,
      env: {
        ...process.env,
        PORT: String(port),
        HOME: dir,
        USERPROFILE: dir,
        ORCH_REPO: "",
        ORCH_REPOS: "",
        YAAIORCH_UI_SETTINGS: join(dir, "ui.json"),
        CLOUDFLARED_BIN: join(root, "test", "fake-cloudflared", "cloudflared.mjs"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("server did not start")), 30_000);
      srv.stdout.on("data", (d) => String(d).includes(`localhost:${port}`) && (clearTimeout(t), ok()));
      srv.on("exit", (c) => fail(new Error(`server exited ${c}`)));
    });
    token = (await request("/api/token")).json().token;
  });
  after(() => {
    // The whole tree (tsx, the server, a fake cloudflared): on Windows kill() would leave them holding the folder.
    if (srv?.pid && process.platform === "win32") spawnSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { stdio: "ignore" });
    else srv?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test("off by default: tunnel requests are refused", async () => {
    assert.equal((await remoteReq("/api/state")).status, 403);
    assert.equal((await remoteReq("/")).status, 403);
  });

  test("the PC turns it on, pairs a phone that starts view-only, gives it control, then revokes it", async () => {
    const on = await pc("/api/remote/enable", { on: true });
    assert.equal(on.status, 200, on.text);
    let status;
    for (let i = 0; i < 100 && status?.tunnel.status !== "on"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await pc("/api/remote")).json();
    }
    assert.equal(status.tunnel.url, ORIGIN);

    assert.equal((await remoteReq("/api/state")).status, 401, "not paired");
    assert.equal((await remoteReq("/api/token")).status, 401, "the local token is never reachable");
    assert.equal((await remoteReq("/api/remote")).status, 401);

    const link = (await pc("/api/remote/pair-code", {})).json().url;
    assert.ok(link.startsWith(`${ORIGIN}/pair#`), link);
    const code = link.split("#")[1];
    assert.equal(
      (await remoteReq("/api/pair", { method: "POST", body: { code, name: "Pixel" }, origin: "https://evil.example" })).status,
      403,
      "only from the tunnel's own page",
    );
    const req = (await remoteReq("/api/pair", { method: "POST", body: { code, name: "Pixel" } })).json();
    assert.ok(req.id && req.poll);
    assert.equal((await remoteReq("/api/pair", { method: "POST", body: { code, name: "Again" } })).status, 403, "a code works once");

    const poll = () => remoteReq("/api/pair/status", { method: "POST", body: { id: req.id, poll: req.poll } });
    assert.equal((await poll()).json().status, "waiting");
    const pending = (await pc("/api/remote")).json().requests;
    assert.equal(pending[0].name, "Pixel");
    assert.equal((await pc("/api/remote/decide", { id: req.id, allow: true })).status, 200);
    const allowed = await poll();
    assert.equal(allowed.json().status, "allowed");
    const setCookie = allowed.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];

    const state = await remoteReq("/api/state", { cookie });
    assert.equal(state.status, 200, state.text);
    assert.ok(Array.isArray(state.json().sessions));
    assert.equal((await remoteReq("/api/stop", { method: "POST", cookie, body: { repo: "x" } })).status, 403, "view-only");

    const id = (await pc("/api/remote")).json().devices[0].id;
    assert.equal((await pc("/api/remote/device", { id, role: "control" })).status, 200);
    assert.notEqual((await remoteReq("/api/stop", { method: "POST", cookie, body: { repo: "x" } })).status, 403, "control may act");
    assert.equal((await remoteReq("/api/settings", { method: "POST", cookie, body: { dailyBudget: 1000 } })).status, 403, "limits stay on the PC");
    assert.equal((await remoteReq("/api/decide-command", { method: "POST", cookie, body: { repo: "x", id: "1", decision: "always" } })).status, 403);
    assert.equal((await remoteReq("/api/remote/enable", { method: "POST", cookie, body: { on: false } })).status, 403);
    assert.equal(
      (await remoteReq("/api/stop", { method: "POST", cookie, body: { repo: "x" }, origin: "https://evil.example" })).status,
      403,
      "cross-site writes fail",
    );

    assert.equal((await pc("/api/remote/device", { id, revoke: true })).status, 200);
    assert.equal((await remoteReq("/api/state", { cookie })).status, 401, "revoked");
  });

  test("a local process cannot pass as the PC by adding Cloudflare's headers", async () => {
    const r = await request("/api/state", { headers: { "x-orch-token": token, "cf-ray": "x" } });
    assert.equal(r.status, 403);
  });

  test("remote access is never remembered: the next start begins with it off", () => {
    assert.ok(!readFileSync(join(dir, "ui.json"), "utf8").includes("remote"), "nothing about remote access in the settings");
  });

  test("turning it off stops the tunnel and refuses tunnel requests again", async () => {
    assert.equal((await pc("/api/remote/enable", { on: false })).json().tunnel.status, "off");
    assert.equal((await remoteReq("/api/state")).status, 403);
  });
});
