import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../src/server.js";

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
const post = (base, body, raw) =>
  fetch(`${base}/todos`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });

test("creates todos with increasing ids", () =>
  withServer({}, async (base) => {
    let res = await post(base, { title: "  buy milk  " });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 1, title: "buy milk", done: false });
    res = await post(base, { title: "second" });
    assert.equal((await res.json()).id, 2);
    const list = await (await fetch(`${base}/todos`)).json();
    assert.deepEqual(list.map((t) => t.title), ["buy milk", "second"]);
  }));
test("ids continue after seeded todos", () =>
  withServer({ todos: [{ id: 7, title: "old", done: true }] }, async (base) => {
    const res = await post(base, { title: "new" });
    assert.equal((await res.json()).id, 8);
  }));
test("rejects bad input with 400 and an error", () =>
  withServer({}, async (base) => {
    for (const body of [{}, { title: "" }, { title: "   " }, { title: 5 }, { title: "x".repeat(201) }]) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof (await res.json()).error, "string");
    }
    const res = await post(base, null, "{not json");
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, "string");
    const ok = await post(base, { title: "x".repeat(200) });
    assert.equal(ok.status, 201);
    assert.equal((await (await fetch(`${base}/todos`)).json()).length, 1);
  }));
