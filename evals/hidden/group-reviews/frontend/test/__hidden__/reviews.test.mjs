// Graded against the backend the same run built (EVAL_BACKEND): the web client and the API must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { withBackend, web } = await import(pathToFileURL(join(process.env.YAAIORCH_EVALS, "lib", "backend.mjs")).href);
const { createApi, ApiError } = await web("src/api.js");
const { renderRating } = await web("src/render.js");

const products = () => [
  { id: "p1", name: "Mug", priceCents: 1250, stock: 3 },
  { id: "p2", name: "Pot", priceCents: 900, stock: 1 },
];
const isApiError = (status) => (e) => e instanceof ApiError && e.status === status;

test("addReview returns the created review", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    const before = Date.now();
    const r = await api.addReview("p1", { rating: 5, comment: "  Great mug  " });
    assert.equal(r.productId, "p1");
    assert.equal(r.rating, 5);
    assert.equal(r.comment, "Great mug");
    assert.ok(r.id !== undefined && r.id !== null && r.id !== "", "the review has an id");
    assert.equal(typeof r.createdAt, "string");
    const t = Date.parse(r.createdAt);
    assert.ok(t >= before - 60_000 && t <= Date.now() + 60_000, `createdAt ${r.createdAt} is the time it was created`);
    const empty = await api.addReview("p1", { rating: 3, comment: "" });
    assert.equal(empty.comment, "");
  }));

test("listReviews returns every review, newest first", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    for (let i = 1; i <= 23; i++) await api.addReview("p1", { rating: (i % 5) + 1, comment: `r${i}` });
    await api.addReview("p2", { rating: 1, comment: "other" });
    const list = await api.listReviews("p1");
    assert.deepEqual(
      list.map((r) => r.comment),
      Array.from({ length: 23 }, (_, i) => `r${23 - i}`),
    );
    assert.deepEqual(await api.listReviews("p2").then((l) => l.map((r) => r.comment)), ["other"]);
  }));

test("a product without reviews has none", () =>
  withBackend({ products: products() }, async (base) => {
    assert.deepEqual(await createApi(base).listReviews("p2"), []);
  }));

test("products carry averageRating and reviewCount", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    for (const rating of [5, 4, 4]) await api.addReview("p1", { rating, comment: "" });
    const p1 = await api.getProduct("p1");
    assert.equal(p1.averageRating, 4.3);
    assert.equal(p1.reviewCount, 3);
    assert.equal(p1.priceCents, 1250, "the product keeps its other fields");
    const p2 = await api.getProduct("p2");
    assert.equal(p2.averageRating, null);
    assert.equal(p2.reviewCount, 0);
    const listed = await api.listProducts();
    assert.equal(listed.find((p) => p.id === "p1").averageRating, 4.3);
    assert.equal(listed.find((p) => p.id === "p1").reviewCount, 3);
    assert.equal(listed.find((p) => p.id === "p2").reviewCount, 0);
    await api.addReview("p2", { rating: 1, comment: "" });
    await api.addReview("p2", { rating: 2, comment: "" });
    await api.addReview("p2", { rating: 2, comment: "" });
    assert.equal((await api.getProduct("p2")).averageRating, 1.7);
  }));

test("invalid reviews are rejected with status 400 and change nothing", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    for (const bad of [
      { rating: 0, comment: "" },
      { rating: 6, comment: "" },
      { rating: 2.5, comment: "" },
      { rating: "4", comment: "" },
      { comment: "no rating" },
      { rating: 4, comment: "x".repeat(501) },
    ])
      await assert.rejects(api.addReview("p1", bad), isApiError(400), JSON.stringify(bad).slice(0, 60));
    assert.equal((await api.addReview("p1", { rating: 4, comment: ` ${"y".repeat(500)} ` })).comment.length, 500);
    assert.equal((await api.getProduct("p1")).reviewCount, 1);
  }));

test("an unknown product is a 404", () =>
  withBackend({ products: products() }, async (base) => {
    const api = createApi(base);
    await assert.rejects(api.addReview("p99", { rating: 4, comment: "" }), isApiError(404));
    await assert.rejects(api.listReviews("p99"), isApiError(404));
  }));

test("renderRating", () => {
  assert.equal(renderRating({ averageRating: 4.5, reviewCount: 12 }), "★ 4.5 (12 reviews)");
  assert.equal(renderRating({ averageRating: 4, reviewCount: 2 }), "★ 4.0 (2 reviews)");
  assert.equal(renderRating({ averageRating: 3, reviewCount: 1 }), "★ 3.0 (1 review)");
  assert.equal(renderRating({ averageRating: null, reviewCount: 0 }), "No reviews yet");
});
