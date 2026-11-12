import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../src/store.js";
import { createTicketService } from "../../src/tickets.js";
import { createApp } from "../../src/http.js";
import { ValidationError, NotFoundError } from "../../src/errors.js";

const clock = { now: () => new Date("2026-03-02T10:00:00.000Z") };
const service = (seed = []) => createTicketService({ store: createStore(seed), clock });

async function withApp(svc, fn) {
  const server = createApp({ service: svc });
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const send = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------- goal 1: tags ----------
test("create: tags are normalized, deduplicated and default to []", () => {
  const s = service();
  assert.deepEqual(s.create({ title: "a" }).tags, []);
  assert.deepEqual(s.create({ title: "b", tags: [" VPN ", "network", "vpn", "net-2"] }).tags, ["vpn", "network", "net-2"]);
  assert.deepEqual(s.get(2).tags, ["vpn", "network", "net-2"]);
});

test("create: invalid tags and more than 10 are rejected", () => {
  const s = service();
  for (const tags of [["1abc"], ["has space"], ["x".repeat(21)], [""], [42], ["ok", "Bad_Tag"]])
    assert.throws(() => s.create({ title: "t", tags }), ValidationError, JSON.stringify(tags));
  assert.throws(() => s.create({ title: "t", tags: "vpn" }), ValidationError, "not an array");
  assert.throws(() => s.create({ title: "t", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), ValidationError);
  assert.deepEqual(s.create({ title: "t", tags: [...Array.from({ length: 10 }, (_, i) => `t${i}`), "T0"] }).tags.length, 10, "duplicates do not count");
  assert.equal(s.list().length, 1, "nothing stored for rejected tickets");
});

test("addTag and removeTag", () => {
  const s = service();
  s.create({ title: "a", tags: ["vpn"] });
  assert.deepEqual(s.addTag(1, " Urgent-Fix ").tags, ["vpn", "urgent-fix"]);
  assert.deepEqual(s.addTag(1, "vpn").tags, ["vpn", "urgent-fix"], "adding an existing tag is a no-op");
  assert.deepEqual(s.removeTag(1, "VPN").tags, ["urgent-fix"]);
  assert.deepEqual(s.removeTag(1, "absent").tags, ["urgent-fix"], "removing a missing tag is a no-op");
  assert.throws(() => s.addTag(1, "no way"), ValidationError);
  assert.throws(() => s.addTag(9, "x"), NotFoundError);
  assert.throws(() => s.removeTag(9, "x"), NotFoundError);
  s.create({ title: "full", tags: Array.from({ length: 10 }, (_, i) => `t${i}`) });
  assert.throws(() => s.addTag(2, "eleven"), ValidationError);
  assert.equal(s.addTag(2, "t3").tags.length, 10, "an existing tag on a full ticket is fine");
});

test("HTTP: create with tags, add and remove a tag", () =>
  withApp(service(), async (base) => {
    let res = await fetch(`${base}/tickets`, send("POST", { title: "VPN down", tags: ["VPN"] }));
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).tags, ["vpn"]);
    res = await fetch(`${base}/tickets/1/tags`, send("POST", { tag: "network" }));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).tags, ["vpn", "network"]);
    res = await fetch(`${base}/tickets/1/tags/vpn`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).tags, ["network"]);
    assert.equal((await fetch(`${base}/tickets/1/tags`, send("POST", { tag: "bad tag" }))).status, 400);
    assert.equal((await fetch(`${base}/tickets`, send("POST", { title: "x", tags: ["9"] }))).status, 400);
    assert.equal((await fetch(`${base}/tickets/7/tags`, send("POST", { tag: "x" }))).status, 404);
    assert.equal((await fetch(`${base}/tickets/7/tags/x`, { method: "DELETE" })).status, 404);
    const err = await (await fetch(`${base}/tickets/1/tags`, send("POST", {}))).json();
    assert.equal(typeof err.error, "string", "errors keep the { error } shape");
  }));

// ---------- goal 2: filter by tag ----------
test("list filters by tag, combined with status and assignee; old tickets have no tags", () => {
  const s = service([{ id: 1, title: "legacy", priority: "normal", status: "open", assignee: null, createdAt: "2026-01-01T00:00:00.000Z" }]);
  s.create({ title: "a", tags: ["vpn"], assignee: "ana" });
  s.create({ title: "b", tags: ["vpn", "db"] });
  s.create({ title: "c", tags: ["db"] });
  s.close(3);
  assert.deepEqual(s.get(1).tags, [], "a ticket stored before tags existed has tags []");
  assert.deepEqual(s.list().find((t) => t.id === 1).tags, []);
  assert.deepEqual(s.list({ tag: "vpn" }).map((t) => t.id), [2, 3]);
  assert.deepEqual(s.list({ tag: " VPN " }).map((t) => t.id), [2, 3], "the filter is normalized too");
  assert.deepEqual(s.list({ tag: "vpn", status: "open" }).map((t) => t.id), [2]);
  assert.deepEqual(s.list({ tag: "vpn", assignee: "ana" }).map((t) => t.id), [2]);
  assert.deepEqual(s.list({ tag: "none" }), []);
  assert.throws(() => s.list({ tag: "bad tag" }), ValidationError);
});

test("HTTP: GET /tickets?tag=", () =>
  withApp(service(), async (base) => {
    await fetch(`${base}/tickets`, send("POST", { title: "a", tags: ["vpn"] }));
    await fetch(`${base}/tickets`, send("POST", { title: "b" }));
    const res = await fetch(`${base}/tickets?tag=vpn`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).map((t) => t.id), [1]);
    assert.equal((await fetch(`${base}/tickets?tag=no%20way`)).status, 400);
  }));

// ---------- goal 3: tag stats ----------
test("tagStats: open and total per tag, by total then name", () => {
  const s = service([{ id: 1, title: "legacy", priority: "normal", status: "open", assignee: null, createdAt: "2026-01-01T00:00:00.000Z" }]);
  s.create({ title: "a", tags: ["vpn", "db"] });
  s.create({ title: "b", tags: ["db"] });
  s.create({ title: "c", tags: ["auth", "vpn"] });
  s.create({ title: "d", tags: ["db"] });
  s.close(3);
  s.close(5);
  assert.deepEqual(s.tagStats(), [
    { tag: "db", open: 1, total: 3 },
    { tag: "vpn", open: 2, total: 2 },
    { tag: "auth", open: 1, total: 1 },
  ]);
  assert.deepEqual(service().tagStats(), []);
});

test("HTTP: GET /tags", () =>
  withApp(service(), async (base) => {
    await fetch(`${base}/tickets`, send("POST", { title: "a", tags: ["b-tag", "a-tag"] }));
    await fetch(`${base}/tickets`, send("POST", { title: "b", tags: ["b-tag"] }));
    await fetch(`${base}/tickets/2/close`, { method: "POST" });
    const res = await fetch(`${base}/tags`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [
      { tag: "b-tag", open: 1, total: 2 },
      { tag: "a-tag", open: 1, total: 1 },
    ]);
  }));
