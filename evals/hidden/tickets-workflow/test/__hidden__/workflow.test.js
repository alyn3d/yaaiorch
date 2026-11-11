import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../src/store.js";
import { createTicketService } from "../../src/tickets.js";
import { createApp } from "../../src/http.js";
import { ValidationError, NotFoundError, ConflictError } from "../../src/errors.js";

function setup() {
  let now = new Date("2026-03-02T10:00:00.000Z");
  const clock = { now: () => now };
  const service = createTicketService({ store: createStore(), clock });
  return { service, setNow: (iso) => (now = new Date(iso)) };
}

async function withApp(fn) {
  const { service } = setup();
  const server = createApp({ service });
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, service);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the full happy path records history", () => {
  const { service, setNow } = setup();
  const t = service.create({ title: "Laptop", assignee: "ana" });
  assert.equal(t.status, "open");
  assert.deepEqual(service.history(t.id), []);
  setNow("2026-03-02T11:00:00.000Z");
  assert.equal(service.transition(t.id, "in_progress", "ana").status, "in_progress");
  setNow("2026-03-02T12:00:00.000Z");
  service.transition(t.id, "resolved", "ana");
  setNow("2026-03-02T13:00:00.000Z");
  service.transition(t.id, "closed", "bo");
  setNow("2026-03-03T09:00:00.000Z");
  service.transition(t.id, "open", "cy");
  assert.deepEqual(service.history(t.id), [
    { from: "open", to: "in_progress", by: "ana", at: "2026-03-02T11:00:00.000Z" },
    { from: "in_progress", to: "resolved", by: "ana", at: "2026-03-02T12:00:00.000Z" },
    { from: "resolved", to: "closed", by: "bo", at: "2026-03-02T13:00:00.000Z" },
    { from: "closed", to: "open", by: "cy", at: "2026-03-03T09:00:00.000Z" },
  ]);
  assert.equal(service.get(t.id).status, "open");
});

test("allowed and forbidden transitions", () => {
  const { service } = setup();
  const t = service.create({ title: "x", assignee: "ana" });
  for (const to of ["resolved", "closed", "open"]) assert.throws(() => service.transition(t.id, to, "ana"), ConflictError, `open -> ${to}`);
  service.transition(t.id, "in_progress", "ana");
  service.transition(t.id, "open", "ana"); // in_progress -> open
  service.transition(t.id, "in_progress", "ana");
  assert.throws(() => service.transition(t.id, "closed", "ana"), ConflictError, "in_progress -> closed");
  service.transition(t.id, "resolved", "ana");
  assert.throws(() => service.transition(t.id, "in_progress", "ana"), ConflictError, "resolved -> in_progress");
  service.transition(t.id, "open", "ana"); // resolved -> open
  service.transition(t.id, "in_progress", "ana");
  service.transition(t.id, "resolved", "ana");
  service.transition(t.id, "closed", "ana");
  for (const to of ["in_progress", "resolved", "closed"]) assert.throws(() => service.transition(t.id, to, "ana"), ConflictError, `closed -> ${to}`);
  assert.equal(service.history(t.id).length, 8, "only the 8 successful transitions are recorded");
});

test("in_progress needs an assignee; inputs are validated", () => {
  const { service } = setup();
  const t = service.create({ title: "x" });
  assert.throws(() => service.transition(t.id, "in_progress", "ana"), ConflictError);
  service.assign(t.id, "ana");
  assert.equal(service.transition(t.id, "in_progress", "ana").status, "in_progress");
  assert.throws(() => service.transition(t.id, "done", "ana"), ValidationError);
  assert.throws(() => service.transition(t.id, "resolved", "Not Valid"), ValidationError);
  assert.throws(() => service.transition(t.id, "resolved"), ValidationError);
  assert.throws(() => service.transition(99, "resolved", "ana"), NotFoundError);
  assert.throws(() => service.history(99), NotFoundError);
});

test("list accepts the new statuses", () => {
  const { service } = setup();
  service.create({ title: "a", assignee: "ana" });
  service.create({ title: "b", assignee: "bo" });
  service.transition(2, "in_progress", "bo");
  assert.deepEqual(service.list({ status: "in_progress" }).map((t) => t.id), [2]);
  assert.deepEqual(service.list({ status: "open" }).map((t) => t.id), [1]);
  assert.deepEqual(service.list({ status: "resolved" }), []);
  assert.throws(() => service.list({ status: "weird" }), ValidationError);
});

test("HTTP: transitions, history, errors, and /close is gone", () =>
  withApp(async (base) => {
    await fetch(`${base}/tickets`, post({ title: "VPN", assignee: "ana" }));
    await fetch(`${base}/tickets`, post({ title: "No owner" }));
    let res = await fetch(`${base}/tickets/1/transitions`, post({ to: "in_progress", by: "ana" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "in_progress");
    res = await fetch(`${base}/tickets?status=in_progress`);
    assert.deepEqual((await res.json()).map((t) => t.id), [1]);
    res = await fetch(`${base}/tickets/1/history`);
    assert.equal(res.status, 200);
    const history = await res.json();
    assert.equal(history.length, 1);
    assert.deepEqual({ ...history[0], at: undefined }, { from: "open", to: "in_progress", by: "ana", at: undefined });

    const expect = async (path, body, status) => {
      const r = await fetch(`${base}${path}`, post(body));
      assert.equal(r.status, status, `${path} ${JSON.stringify(body)}`);
      assert.equal(typeof (await r.json()).error, "string");
    };
    await expect("/tickets/1/transitions", { to: "closed", by: "ana" }, 409);
    await expect("/tickets/2/transitions", { to: "in_progress", by: "ana" }, 409);
    await expect("/tickets/1/transitions", { to: "nope", by: "ana" }, 400);
    await expect("/tickets/1/transitions", { to: "resolved" }, 400);
    await expect("/tickets/9/transitions", { to: "resolved", by: "ana" }, 404);
    assert.equal((await fetch(`${base}/tickets/9/history`)).status, 404);
    assert.equal((await fetch(`${base}/tickets/1/close`, { method: "POST" })).status, 404);
  }));
