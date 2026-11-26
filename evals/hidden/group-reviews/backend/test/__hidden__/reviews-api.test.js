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

const seed = () => ({ products: [{ id: "p1", name: "Mug", priceCents: 1250, stock: 3 }] });
const post = (base, path, body) => fetch(`${base}${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("the API itself validates reviews, in its error shape", () =>
  withServer(seed(), async (base) => {
    for (const body of [{ rating: 0, comment: "" }, { rating: 6, comment: "" }, { rating: 2.5, comment: "" }, { rating: "4", comment: "" }, { comment: "" }, { rating: 4, comment: "x".repeat(501) }]) {
      const res = await post(base, "/products/p1/reviews", body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal((await res.json()).error.code, "validation_failed");
    }
    const bad = await post(base, "/products/p1/reviews", "{");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "bad_json");
    const ok = await post(base, "/products/p1/reviews", { rating: 4, comment: "fine" });
    assert.equal(ok.status, 201);
  }));

test("reviews of an unknown product are a 404 in the error shape", () =>
  withServer(seed(), async (base) => {
    const res = await post(base, "/products/p9/reviews", { rating: 4, comment: "" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
    const list = await fetch(`${base}/products/p9/reviews`);
    assert.equal(list.status, 404);
    assert.equal((await list.json()).error.code, "not_found");
  }));
