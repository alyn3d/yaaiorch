// Graded against the backend the same run built (EVAL_BACKEND): the web client and the API must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { withBackend, web } = await import(pathToFileURL(join(process.env.YAAIORCH_EVALS, "lib", "backend.mjs")).href);
const { createApi } = await web("src/api.js");
const { toCents } = await web("src/money.js");

const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Product ${i + 1}`, priceCents: 100 + i, stock: i }));

test("listProducts returns every product, in order", () =>
  withBackend({ products: many(27) }, async (base) => {
    const list = await createApi(base).listProducts();
    assert.deepEqual(
      list.map((p) => p.id),
      many(27).map((p) => p.id),
    );
    assert.equal(list[26].priceCents, 126);
  }));

test("listProducts with exactly one page and with none", async () => {
  await withBackend({ products: many(10) }, async (base) => assert.equal((await createApi(base).listProducts()).length, 10));
  await withBackend({}, async (base) => assert.deepEqual(await createApi(base).listProducts(), []));
});

test("prices typed with one decimal are saved right", () =>
  withBackend({}, async (base) => {
    const api = createApi(base);
    const cases = { "12.5": 1250, "12.50": 1250, "0.5": 50, "0.05": 5, 7: 700, "19.99": 1999, " 3.1 ": 310 };
    for (const [price, cents] of Object.entries(cases)) {
      const created = await api.createProduct({ name: `at ${price}`, price });
      assert.equal((await api.getProduct(created.id)).priceCents, cents, `price "${price}"`);
    }
  }));

test("toCents", () => {
  assert.equal(toCents("12.5"), 1250);
  assert.equal(toCents("0.5"), 50);
  assert.equal(toCents("12.50"), 1250);
  assert.equal(toCents("3"), 300);
  assert.equal(toCents("0.07"), 7);
});
