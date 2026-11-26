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

const seed = () => ({ products: [{ id: "p1", name: "Mug", priceCents: 1250, stock: 2 }] });
const order = (base, body) => fetch(`${base}/orders`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const stock = async (base) => (await (await fetch(`${base}/products/p1`)).json()).stock;

test("ordering more than the stock is a 409 out_of_stock and changes nothing", () =>
  withServer(seed(), async (base) => {
    const res = await order(base, { productId: "p1", quantity: 3 });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "out_of_stock");
    assert.match(body.error.message, /\b2\b/, "the message says how many are left");
    assert.equal(await stock(base), 2);
  }));

test("bad quantities and bodies are 400 in the API's error shape", () =>
  withServer(seed(), async (base) => {
    for (const quantity of [0, -1, 1.5, "1", null]) {
      const res = await order(base, { productId: "p1", quantity });
      assert.equal(res.status, 400, `quantity ${String(quantity)}`);
      assert.equal((await res.json()).error.code, "validation_failed");
    }
    const bad = await order(base, "{");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "bad_json");
    assert.equal(await stock(base), 2);
  }));

test("an unknown product is a 404", () =>
  withServer(seed(), async (base) => {
    const res = await order(base, { productId: "p9", quantity: 1 });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  }));

test("an order takes its quantity from the stock", () =>
  withServer(seed(), async (base) => {
    assert.equal((await order(base, { productId: "p1", quantity: 2 })).status, 201);
    assert.equal(await stock(base), 0);
    assert.equal((await order(base, { productId: "p1", quantity: 1 })).status, 409);
  }));
