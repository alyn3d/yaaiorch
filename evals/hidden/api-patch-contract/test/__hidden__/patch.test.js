import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../src/server.js";
import { ROUTES } from "../../src/routes.js";

const seed = () => [
  { id: 1, title: "first", done: false },
  { id: 7, title: "second", done: true },
];

async function withServer(fn) {
  const server = createServer({ todos: seed() });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const patch = (base, id, body) =>
  fetch(`${base}/todos/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("PATCH /todos/:id is registered", () => {
  assert.ok(ROUTES.some((r) => r.method === "PATCH" && r.path === "/todos/:id"));
});

test("updates the title (trimmed) and/or done; returns the todo; GET shows it", () =>
  withServer(async (base) => {
    let res = await patch(base, 7, { title: "  renamed  " });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 7, title: "renamed", done: true });
    res = await patch(base, 1, { done: true });
    assert.deepEqual(await res.json(), { id: 1, title: "first", done: true });
    res = await patch(base, 1, { title: "both", done: false });
    assert.deepEqual(await res.json(), { id: 1, title: "both", done: false });
    const all = await (await fetch(`${base}/todos`)).json();
    assert.deepEqual(all, [
      { id: 1, title: "both", done: false },
      { id: 7, title: "renamed", done: true },
    ]);
  }));

test("unknown id is 404 with an error body", () =>
  withServer(async (base) => {
    const res = await patch(base, 99, { done: true });
    assert.equal(res.status, 404);
    assert.equal(typeof (await res.json()).error, "string");
  }));

test("bad input is 400 with an error body, and changes nothing", () =>
  withServer(async (base) => {
    for (const body of ["{not json", {}, { title: "   " }, { title: "x".repeat(201) }, { title: 5 }, { done: "yes" }, { other: 1 }]) {
      const res = await patch(base, 1, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof (await res.json()).error, "string");
    }
    for (const id of ["abc", "1.5", "0"]) assert.ok([400, 404].includes((await patch(base, id, { done: true })).status), id);
    const all = await (await fetch(`${base}/todos`)).json();
    assert.deepEqual(all, seed());
  }));
