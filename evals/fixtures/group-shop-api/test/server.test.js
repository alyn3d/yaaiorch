import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, PAGE_SIZE } from "../src/server.js";

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

const product = (n) => ({ id: `p${n}`, name: `Product ${n}`, priceCents: 100 * n, stock: n });

test("GET /health", () =>
  withServer({}, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }));

test("GET /products pages through the list", () =>
  withServer({ products: Array.from({ length: PAGE_SIZE + 3 }, (_, i) => product(i + 1)) }, async (base) => {
    const first = await (await fetch(`${base}/products`)).json();
    assert.equal(first.items.length, PAGE_SIZE);
    assert.equal(typeof first.nextCursor, "string");
    const second = await (await fetch(`${base}/products?cursor=${first.nextCursor}`)).json();
    assert.deepEqual(
      second.items.map((p) => p.id),
      ["p11", "p12", "p13"],
    );
    assert.equal(second.nextCursor, null);
  }));

test("GET /products/:id", () =>
  withServer({ products: [product(1)] }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/products/p1`)).json(), product(1));
    const missing = await fetch(`${base}/products/p9`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "not_found");
  }));

test("POST /products creates a product with no stock", () =>
  withServer({ products: [product(1)] }, async (base) => {
    const res = await fetch(`${base}/products`, { method: "POST", body: JSON.stringify({ name: " Mug ", priceCents: 1250 }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: "p2", name: "Mug", priceCents: 1250, stock: 0 });
  }));

test("POST /products rejects a missing name and bad JSON", () =>
  withServer({}, async (base) => {
    const noName = await fetch(`${base}/products`, { method: "POST", body: JSON.stringify({ priceCents: 100 }) });
    assert.equal(noName.status, 400);
    assert.equal((await noName.json()).error.code, "validation_failed");
    const bad = await fetch(`${base}/products`, { method: "POST", body: "{" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "bad_json");
  }));

test("unknown route is 404 in the error shape", () =>
  withServer({}, async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  }));
