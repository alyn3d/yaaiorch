// Browser-mode server (orch-ui/server.ts): only the UI it serves may drive it.
// Starts the server on a free port with a scratch home folder; no repo, no agents, no tokens.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        .on("end", () => ok({ status: res.statusCode, text, json: () => JSON.parse(text) }));
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
});
