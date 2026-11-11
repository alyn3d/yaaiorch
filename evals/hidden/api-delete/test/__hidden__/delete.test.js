import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../src/server.js";

const seed = () => [{ id: 1, title: "a", done: false }, { id: 2, title: "b", done: true }];
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
const del = (base, id) => fetch(`${base}/todos/${id}`, { method: "DELETE" });

test("deletes an existing todo", () =>
  withServer({ todos: seed() }, async (base) => {
    const res = await del(base, 1);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.deepEqual((await (await fetch(`${base}/todos`)).json()).map((t) => t.id), [2]);
  }));
test("404 for an unknown id", () =>
  withServer({ todos: seed() }, async (base) => {
    const res = await del(base, 99);
    assert.equal(res.status, 404);
    assert.equal(typeof (await res.json()).error, "string");
    const again = await del(base, 2);
    assert.equal(again.status, 204);
    assert.equal((await del(base, 2)).status, 404);
  }));
test("400 for an invalid id", () =>
  withServer({ todos: seed() }, async (base) => {
    for (const id of ["abc", "0", "-1", "1.5"]) {
      const res = await del(base, id);
      assert.equal(res.status, 400, id);
      assert.equal(typeof (await res.json()).error, "string");
    }
    assert.equal((await (await fetch(`${base}/todos`)).json()).length, 2);
  }));
