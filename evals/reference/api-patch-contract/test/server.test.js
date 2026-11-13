import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("GET /health", () =>
  withServer({}, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }));

test("GET /todos returns the seeded list", () =>
  withServer({ todos: [{ id: 1, title: "a", done: false }] }, async (base) => {
    const res = await fetch(`${base}/todos`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ id: 1, title: "a", done: false }]);
  }));

test("unknown route is 404", () =>
  withServer({}, async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  }));

test("PATCH /todos/:id updates a todo", () =>
  withServer({ todos: [{ id: 1, title: "a", done: false }] }, async (base) => {
    const res = await fetch(`${base}/todos/1`, { method: "PATCH", body: JSON.stringify({ done: true }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 1, title: "a", done: true });
  }));
