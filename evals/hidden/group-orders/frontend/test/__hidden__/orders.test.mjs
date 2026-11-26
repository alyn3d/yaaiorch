// Graded against the backend the same run built (EVAL_BACKEND): the web client and the API must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { withBackend, web } = await import(pathToFileURL(join(process.env.YAAIORCH_EVALS, "lib", "backend.mjs")).href);
const { createApi, ApiError } = await web("src/api.js");
const { renderOrderError } = await web("src/render.js");

const products = () => [
  { id: "p1", name: "Mug", priceCents: 1250, stock: 3 },
  { id: "p2", name: "Pot", priceCents: 999, stock: 100 },
];

test("placeOrder returns the order and takes the stock", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    const before = Date.now();
    const o = await api.placeOrder("p1", 2);
    assert.equal(o.productId, "p1");
    assert.equal(o.quantity, 2);
    assert.equal(o.totalCents, 2500);
    assert.ok(o.id !== undefined && o.id !== null && o.id !== "", "the order has an id");
    const t = Date.parse(o.createdAt);
    assert.ok(t >= before - 60_000 && t <= Date.now() + 60_000, `createdAt ${o.createdAt}`);
    assert.equal((await api.getProduct("p1")).stock, 1);
  }));

test("out of stock: a 409 ApiError with the API's code and message, and nothing changes", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    let error;
    await api.placeOrder("p1", 4).catch((e) => (error = e));
    assert.ok(error instanceof ApiError, "rejects with an ApiError");
    assert.equal(error.status, 409);
    assert.equal(error.code, "out_of_stock");
    assert.match(error.message, /\b3\b/, "the message says how many are left");
    assert.equal(renderOrderError(error), error.message);
    assert.equal((await api.getProduct("p1")).stock, 3);
    assert.deepEqual(await api.listOrders(), []);
  }));

test("bad quantity is a 400, an unknown product a 404", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    for (const q of [0, -2, 1.5]) await assert.rejects(api.placeOrder("p1", q), (e) => e instanceof ApiError && e.status === 400, String(q));
    let missing;
    await api.placeOrder("p99", 1).catch((e) => (missing = e));
    assert.ok(missing instanceof ApiError && missing.status === 404);
    assert.equal(renderOrderError(missing), "This product no longer exists.");
  }));

test("listOrders returns every order, newest first", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    for (let q = 1; q <= 13; q++) await api.placeOrder("p2", q);
    const list = await api.listOrders();
    assert.deepEqual(
      list.map((o) => o.quantity),
      Array.from({ length: 13 }, (_, i) => 13 - i),
    );
    assert.equal(list[0].totalCents, 13 * 999);
    assert.equal((await api.getProduct("p2")).stock, 100 - 91);
  }));

test("renderOrderError for anything else", () => {
  assert.equal(renderOrderError(new ApiError(500, "unknown", "boom")), "Something went wrong, please try again.");
  assert.equal(renderOrderError(new Error("network down")), "Something went wrong, please try again.");
});
