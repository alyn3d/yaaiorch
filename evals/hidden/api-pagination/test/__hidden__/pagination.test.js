import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../src/server.js";

// Seeded out of id order on purpose.
const seed = () => [
  { id: 3, title: "c", done: true },
  { id: 1, title: "a", done: false },
  { id: 5, title: "e", done: false },
  { id: 2, title: "b", done: true },
  { id: 4, title: "d", done: false },
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
const get = async (base, query) => {
  const res = await fetch(`${base}/todos${query}`);
  return { status: res.status, total: res.headers.get("x-total-count"), body: await res.json() };
};
const ids = (body) => body.map((t) => t.id);

test("no parameters: everything, in id order, with the total", () =>
  withServer(async (base) => {
    const r = await get(base, "");
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body), [1, 2, 3, 4, 5]);
    assert.equal(r.total, "5");
  }));

test("done filter", () =>
  withServer(async (base) => {
    const done = await get(base, "?done=true");
    assert.deepEqual(ids(done.body), [2, 3]);
    assert.equal(done.total, "2");
    const open = await get(base, "?done=false");
    assert.deepEqual(ids(open.body), [1, 4, 5]);
    assert.equal(open.total, "3");
  }));

test("limit and offset", () =>
  withServer(async (base) => {
    const page = await get(base, "?limit=2&offset=1");
    assert.deepEqual(ids(page.body), [2, 3]);
    assert.equal(page.total, "5");
    assert.deepEqual(ids((await get(base, "?limit=2")).body), [1, 2]);
    assert.deepEqual(ids((await get(base, "?offset=3")).body), [4, 5]);
    const filtered = await get(base, "?done=false&limit=1&offset=1");
    assert.deepEqual(ids(filtered.body), [4]);
    assert.equal(filtered.total, "3");
    const past = await get(base, "?offset=10");
    assert.deepEqual(past.body, []);
    assert.equal(past.total, "5");
    assert.deepEqual(ids((await get(base, "?limit=100")).body), [1, 2, 3, 4, 5]);
  }));

test("invalid parameters get 400 with an error", () =>
  withServer(async (base) => {
    for (const q of ["?done=yes", "?done=", "?limit=0", "?limit=101", "?limit=1.5", "?limit=abc", "?offset=-1", "?offset=x", "?offset=2.5", "?page=2"]) {
      const res = await fetch(`${base}/todos${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(typeof (await res.json()).error, "string", q);
    }
  }));
