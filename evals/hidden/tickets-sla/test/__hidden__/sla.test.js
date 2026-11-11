import { test } from "node:test";
import assert from "node:assert/strict";
import { addBusinessHours, SLA_HOURS } from "../../src/sla.js";
import { createStore } from "../../src/store.js";
import { createTicketService } from "../../src/tickets.js";
import { createApp } from "../../src/http.js";
import { ValidationError } from "../../src/errors.js";

// 2026-03-02 is a Monday.
const add = (iso, h) => addBusinessHours(new Date(iso), h).toISOString();

test("SLA hours", () => {
  assert.deepEqual(SLA_HOURS, { urgent: 4, high: 8, normal: 24, low: 40 });
});

test("addBusinessHours inside one day and across days", () => {
  assert.equal(add("2026-03-02T10:00:00.000Z", 4), "2026-03-02T14:00:00.000Z");
  assert.equal(add("2026-03-02T09:00:00.000Z", 8), "2026-03-02T17:00:00.000Z", "a deadline at 17:00 stays at 17:00");
  assert.equal(add("2026-03-02T15:00:00.000Z", 4), "2026-03-03T11:00:00.000Z");
  assert.equal(add("2026-03-02T16:30:00.000Z", 1), "2026-03-03T09:30:00.000Z");
  assert.equal(add("2026-03-05T12:00:00.000Z", 24), "2026-03-10T12:00:00.000Z", "Thursday noon + 3 business days crosses a weekend");
});

test("addBusinessHours outside business hours and over weekends", () => {
  assert.equal(add("2026-03-06T16:00:00.000Z", 4), "2026-03-09T12:00:00.000Z", "Friday 16:00 + 4h");
  assert.equal(add("2026-03-07T10:00:00.000Z", 1), "2026-03-09T10:00:00.000Z", "Saturday counts from Monday 09:00");
  assert.equal(add("2026-03-07T10:00:00.000Z", 0), "2026-03-09T09:00:00.000Z");
  assert.equal(add("2026-03-02T08:00:00.000Z", 2), "2026-03-02T11:00:00.000Z", "before opening");
  assert.equal(add("2026-03-02T17:00:00.000Z", 1), "2026-03-03T10:00:00.000Z", "17:00 is closed");
  assert.equal(add("2026-03-02T20:15:00.000Z", 8), "2026-03-03T17:00:00.000Z");
  const start = new Date("2026-03-02T10:00:00.000Z");
  addBusinessHours(start, 5);
  assert.equal(start.toISOString(), "2026-03-02T10:00:00.000Z", "start is not modified");
});

function setup(nowIso = "2026-03-02T10:00:00.000Z") {
  let now = new Date(nowIso);
  const service = createTicketService({ store: createStore(), clock: { now: () => now } });
  return { service, setNow: (iso) => (now = new Date(iso)) };
}

test("tickets get dueAt from their priority, and setPriority recomputes it", () => {
  const { service, setNow } = setup();
  const urgent = service.create({ title: "a", priority: "urgent" });
  assert.equal(urgent.dueAt, "2026-03-02T14:00:00.000Z");
  const normal = service.create({ title: "b" });
  assert.equal(normal.dueAt, "2026-03-05T10:00:00.000Z");
  assert.equal(service.create({ title: "c", priority: "low" }).dueAt, "2026-03-09T10:00:00.000Z");
  setNow("2026-03-04T10:00:00.000Z");
  const changed = service.setPriority(normal.id, "high");
  assert.equal(changed.priority, "high");
  assert.equal(changed.dueAt, "2026-03-03T10:00:00.000Z", "recomputed from createdAt (Mon 10:00 + 8h), not from now");
  assert.equal(service.get(normal.id).dueAt, "2026-03-03T10:00:00.000Z");
  assert.throws(() => service.setPriority(normal.id, "asap"), ValidationError);
});

test("overdue: open tickets past dueAt", () => {
  const { service, setNow } = setup();
  service.create({ title: "urgent", priority: "urgent" }); // due Mon 14:00
  service.create({ title: "normal" }); // due Thu 10:00
  const closed = service.create({ title: "closed urgent", priority: "urgent" });
  service.close(closed.id);
  setNow("2026-03-02T15:00:00.000Z");
  assert.deepEqual(service.list({ overdue: true }).map((t) => t.id), [1]);
  assert.deepEqual(service.list({ overdue: false }).map((t) => t.id), [2, 3]);
  setNow("2026-03-02T14:00:00.000Z");
  assert.deepEqual(service.list({ overdue: true }), [], "due exactly now is not overdue yet");
});

test("HTTP: dueAt, overdue filter, PATCH priority", async () => {
  const { service, setNow } = setup();
  const server = createApp({ service });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, path, body) =>
    fetch(`${base}${path}`, body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method });
  try {
    let res = await req("POST", "/tickets", { title: "API down", priority: "urgent" });
    assert.equal((await res.json()).dueAt, "2026-03-02T14:00:00.000Z");
    await req("POST", "/tickets", { title: "Mouse" });
    setNow("2026-03-02T16:00:00.000Z");
    res = await req("GET", "/tickets?overdue=true");
    assert.deepEqual((await res.json()).map((t) => t.id), [1]);
    res = await req("GET", "/tickets?overdue=false");
    assert.deepEqual((await res.json()).map((t) => t.id), [2]);
    assert.equal((await req("GET", "/tickets?overdue=yes")).status, 400);

    res = await req("PATCH", "/tickets/2", { priority: "urgent" });
    assert.equal(res.status, 200);
    const t = await res.json();
    assert.equal(t.priority, "urgent");
    assert.equal(t.dueAt, "2026-03-02T14:00:00.000Z");
    res = await req("PATCH", "/tickets/2", { assignee: "ana", priority: "low" });
    const both = await res.json();
    assert.equal(both.assignee, "ana");
    assert.equal(both.priority, "low");
    assert.equal((await req("PATCH", "/tickets/2", { priority: "asap" })).status, 400);
    assert.equal((await req("PATCH", "/tickets/2", { assignee: "bo" })).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
