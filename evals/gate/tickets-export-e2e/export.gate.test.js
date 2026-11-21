// Gate suite for tickets-export-e2e: run by orch after the repo's own checks pass; the agents cannot run or read it.
// Starts the app from the repo's own modules, builds tickets with awkward titles through the API (create, assign,
// close), and compares every filtered export with the CSV the goal describes, built independently from GET /tickets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = (f) => import(pathToFileURL(resolve("src", f)).href);
const { createStore } = await load("store.js");
const { createTicketService } = await load("tickets.js");
const { createApp } = await load("http.js");
const { fixedClock } = await load("clock.js");

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ["VPN", "down", ",", '"', '""', "\n", "\r\n", "\r", "café ☕", "=SUM(A1)", "+1", "-", "@here", " ", "x;y", "'", "tab\there"];
const HEAD = ["", "", "", "=", "+", "-", "@"];

const field = (v) => {
  const s = v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const expected = (tickets) =>
  ["id,title,priority,status,assignee,createdAt\r\n"]
    .concat(
      tickets.map(
        (t) => [t.id, /^[=+\-@]/.test(t.title) ? `'${t.title}` : t.title, t.priority, t.status, t.assignee, t.createdAt].map(field).join(",") + "\r\n",
      ),
    )
    .join("");
const show = (s) => JSON.stringify(s);

test("exports match the goal's CSV for every filter after creating, assigning and closing through the API", async () => {
  const service = createTicketService({ store: createStore(), clock: fixedClock("2026-03-02T10:00:00.000Z") });
  const server = createApp({ service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = rng(11);
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    for (let i = 0; i < 40; i++) {
      let title = pick(HEAD);
      for (let k = 1 + Math.floor(r() * 4); k > 0; k--) title += pick(PIECES);
      if (!title.trim()) title += "t";
      const body = { title, priority: pick(["low", "normal", "high", "urgent"]), ...(r() < 0.5 ? { assignee: pick(["ana", "bo_b"]) } : {}) };
      const res = await fetch(`${base}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 201, `creating ${show(body)} failed with ${res.status}`);
      const { id } = await res.json();
      if (r() < 0.3)
        await fetch(`${base}/tickets/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignee: pick(["ana", "cy"]) }) });
      if (r() < 0.4) await fetch(`${base}/tickets/${id}/close`, { method: "POST" });
    }
    for (const q of ["", "?status=open", "?status=closed", "?assignee=ana", "?assignee=cy", "?status=closed&assignee=ana", "?assignee=nobody"]) {
      const listed = await (await fetch(`${base}/tickets${q}`)).json();
      const res = await fetch(`${base}/tickets/export${q}`);
      assert.equal(res.status, 200, `GET /tickets/export${q} returned ${res.status}`);
      assert.match(res.headers.get("content-type") ?? "", /^text\/csv;\s*charset=utf-8$/i, `GET /tickets/export${q}: content type`);
      const got = await res.text();
      const want = expected(listed);
      if (got !== want) {
        const g = got.split("\r\n");
        const w = want.split("\r\n");
        let i = 0;
        while (i < Math.max(g.length, w.length) && g[i] === w[i]) i++;
        assert.fail(`GET /tickets/export${q}: line ${i + 1} (split at CRLF) is ${show(g[i])}, expected ${show(w[i])}`);
      }
    }
    const bad = await fetch(`${base}/tickets/export?status=done`);
    assert.equal(bad.status, 400, "GET /tickets/export?status=done must be a 400");
    assert.equal(typeof (await bad.json()).error, "string", "the 400 body must be JSON { error }");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
