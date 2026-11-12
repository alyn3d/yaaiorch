import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../src/server.js";

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const send = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const errorOf = async (res) => {
  const body = await res.json();
  assert.equal(typeof body.error, "string", "errors are { error: string }");
  return res.status;
};

// ---------- goal 1: create ----------
test("POST /todos creates with the next id, trimmed title, done false", () =>
  withServer({ todos: [{ id: 4, title: "seeded", done: true }] }, async (base) => {
    let res = await fetch(`${base}/todos`, send("POST", { title: "  Buy milk " }));
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 5, title: "Buy milk", done: false });
    res = await fetch(`${base}/todos`, send("POST", { title: "Second", done: true }));
    assert.deepEqual(await res.json(), { id: 6, title: "Second", done: false }, "done is always false on create");
    assert.deepEqual((await (await fetch(`${base}/todos`)).json()).map((t) => t.id), [4, 5, 6]);
  }));

test("POST /todos validates", () =>
  withServer({}, async (base) => {
    for (const body of [{}, { title: "" }, { title: "   " }, { title: 7 }, { title: "x".repeat(101) }, "{nope", "[]"])
      assert.equal(await errorOf(await fetch(`${base}/todos`, send("POST", body))), 400, JSON.stringify(body));
    assert.equal((await fetch(`${base}/todos`, send("POST", { title: "x".repeat(100) }))).status, 201);
    assert.equal((await (await fetch(`${base}/todos`)).json()).length, 1);
  }));

test("ids keep counting after the last todo (never reused)", () =>
  withServer({}, async (base) => {
    await fetch(`${base}/todos`, send("POST", { title: "a" }));
    await fetch(`${base}/todos`, send("POST", { title: "b" }));
    await fetch(`${base}/todos/2`, { method: "DELETE" });
    const res = await fetch(`${base}/todos`, send("POST", { title: "c" }));
    assert.equal((await res.json()).id, 3);
  }));

// ---------- goal 2: update and delete ----------
test("PATCH /todos/:id updates title and/or done", () =>
  withServer({ todos: [{ id: 1, title: "a", done: false }] }, async (base) => {
    let res = await fetch(`${base}/todos/1`, send("PATCH", { done: true }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 1, title: "a", done: true });
    res = await fetch(`${base}/todos/1`, send("PATCH", { title: " b ", done: false }));
    assert.deepEqual(await res.json(), { id: 1, title: "b", done: false });
    assert.deepEqual(await (await fetch(`${base}/todos`)).json(), [{ id: 1, title: "b", done: false }]);
  }));

test("PATCH validates and reports missing todos", () =>
  withServer({ todos: [{ id: 1, title: "a", done: false }] }, async (base) => {
    for (const body of [{}, { done: "yes" }, { title: "" }, { title: "x".repeat(101) }, "{nope"])
      assert.equal(await errorOf(await fetch(`${base}/todos/1`, send("PATCH", body))), 400, JSON.stringify(body));
    assert.equal(await errorOf(await fetch(`${base}/todos/9`, send("PATCH", { done: true }))), 404);
    assert.equal(await errorOf(await fetch(`${base}/todos/abc`, send("PATCH", { done: true }))), 400);
    assert.deepEqual(await (await fetch(`${base}/todos`)).json(), [{ id: 1, title: "a", done: false }], "nothing changed");
  }));

test("DELETE /todos/:id", () =>
  withServer({ todos: [{ id: 1, title: "a", done: false }, { id: 2, title: "b", done: false }] }, async (base) => {
    const res = await fetch(`${base}/todos/1`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.deepEqual((await (await fetch(`${base}/todos`)).json()).map((t) => t.id), [2]);
    assert.equal(await errorOf(await fetch(`${base}/todos/1`, { method: "DELETE" })), 404);
    assert.equal(await errorOf(await fetch(`${base}/todos/0`, { method: "DELETE" })), 400);
  }));

// ---------- goal 3: filters ----------
test("GET /todos?done=&q= filters", () =>
  withServer(
    { todos: [{ id: 1, title: "Buy milk", done: false }, { id: 2, title: "buy bread", done: true }, { id: 3, title: "Call Ana", done: false }] },
    async (base) => {
      const ids = async (qs) => (await (await fetch(`${base}/todos${qs}`)).json()).map((t) => t.id);
      assert.deepEqual(await ids("?done=false"), [1, 3]);
      assert.deepEqual(await ids("?done=true"), [2]);
      assert.deepEqual(await ids("?q=BUY"), [1, 2], "q is a case-insensitive substring of the title");
      assert.deepEqual(await ids("?q=%20buy%20"), [1, 2], "q is trimmed");
      assert.deepEqual(await ids("?q=buy&done=true"), [2]);
      assert.deepEqual(await ids("?q="), [1, 2, 3], "an empty q does not filter");
      assert.deepEqual(await ids("?q=zzz"), []);
      assert.equal(await errorOf(await fetch(`${base}/todos?done=yes`)), 400);
    },
  ));
