import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../src/store.js";
import { createTicketService } from "../../src/tickets.js";
import { createApp } from "../../src/http.js";

async function withApp(fn) {
  const service = createTicketService({ store: createStore(), clock: { now: () => new Date("2026-03-02T10:00:00.000Z") } });
  const server = createApp({ service });
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const csv = (base, body, type = "text/csv") => fetch(`${base}/tickets/import`, { method: "POST", headers: { "content-type": type }, body });
const tickets = async (base) => (await fetch(`${base}/tickets`)).json();

test("imports rows in file order, with defaults", () =>
  withApp(async (base) => {
    const res = await csv(base, "title,priority,assignee\nVPN down,high,ana\nMouse broken,,\n");
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { created: [1, 2], skipped: 0 });
    const all = await tickets(base);
    assert.deepEqual(all.map((t) => [t.title, t.priority, t.assignee, t.status]), [
      ["VPN down", "high", "ana", "open"],
      ["Mouse broken", "normal", null, "open"],
    ]);
  }));

test("columns in any order, quotes, CRLF, charset", () =>
  withApp(async (base) => {
    const body = 'assignee,title\r\nbo,"Printer, 2nd floor"\r\n,"Say ""hi"" to IT"\r\n';
    const res = await csv(base, body, "text/csv; charset=utf-8");
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).created, [1, 2]);
    assert.deepEqual((await tickets(base)).map((t) => [t.title, t.assignee]), [
      ["Printer, 2nd floor", "bo"],
      ['Say "hi" to IT', null],
    ]);
  }));

test("duplicates of existing tickets or earlier rows are skipped", () =>
  withApp(async (base) => {
    await fetch(`${base}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "VPN down" }) });
    const res = await csv(base, "title\n  vpn DOWN \nNew one\nnew ONE\nAnother\n");
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { created: [2, 3], skipped: 2 });
    assert.deepEqual((await tickets(base)).map((t) => t.title), ["VPN down", "New one", "Another"]);
  }));

test("any invalid row: 422 with every invalid row, and nothing is created", () =>
  withApp(async (base) => {
    const res = await csv(base, "title,priority,assignee\nGood one,low,\nBad priority,asap,\nAlso good,,\n,high,\nBad owner,,Not Valid\n");
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.deepEqual(body.errors.map((e) => e.row), [2, 4, 5]);
    assert.ok(body.errors.every((e) => typeof e.error === "string" && e.error.length > 0));
    assert.deepEqual(await tickets(base), []);
  }));

test("bad requests get 400", () =>
  withApp(async (base) => {
    for (const [body, type, why] of [
      ["priority\nhigh\n", "text/csv", "no title column"],
      ["title,owner\nx,ana\n", "text/csv", "unknown column"],
      ['{"title":"x"}', "application/json", "wrong content type"],
    ]) {
      const res = await csv(base, body, type);
      assert.equal(res.status, 400, why);
      assert.equal(typeof (await res.json()).error, "string", why);
    }
    assert.deepEqual(await tickets(base), []);
  }));

test("a header without rows imports nothing", () =>
  withApp(async (base) => {
    const res = await csv(base, "title\n");
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { created: [], skipped: 0 });
  }));
