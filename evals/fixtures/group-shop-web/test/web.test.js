import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApi } from "../src/api.js";
import { formatPrice, toCents } from "../src/money.js";
import { renderProductList } from "../src/render.js";

/** A fetch that answers from `routes` ("GET /products": [status, body]) and records each request. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ method: init.method ?? "GET", path: pathname + search, body: init.body && JSON.parse(init.body) });
    const [status, body] = routes[`${init.method ?? "GET"} ${pathname}${search}`] ?? [404, { error: { code: "not_found", message: "no route" } }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

const mug = { id: "p1", name: "Mug", priceCents: 1250, stock: 3 };

test("listProducts", async () => {
  const api = createApi("http://api.test", { fetch: fakeFetch({ "GET /products": [200, { items: [mug], nextCursor: null }] }) });
  assert.deepEqual(await api.listProducts(), [mug]);
});

test("getProduct and an error answer", async () => {
  const fetch = fakeFetch({ "GET /products/p1": [200, mug] });
  const api = createApi("http://api.test/", { fetch });
  assert.deepEqual(await api.getProduct("p1"), mug);
  await assert.rejects(api.getProduct("p2"), (e) => e instanceof ApiError && e.status === 404 && e.code === "not_found");
});

test("createProduct sends the price in cents", async () => {
  const fetch = fakeFetch({ "POST /products": [201, mug] });
  await createApi("http://api.test", { fetch }).createProduct({ name: "Mug", price: "12.50" });
  assert.deepEqual(fetch.calls[0].body, { name: "Mug", priceCents: 1250 });
});

test("money", () => {
  assert.equal(toCents("12.50"), 1250);
  assert.equal(toCents("3"), 300);
  assert.equal(formatPrice(1250), "$12.50");
  assert.equal(formatPrice(123456), "$1,234.56");
  assert.equal(formatPrice(5), "$0.05");
});

test("renderProductList", () => {
  assert.equal(renderProductList([]), `<p class="empty">No products yet.</p>`);
  const html = renderProductList([mug, { id: "p2", name: "<Pot>", priceCents: 900, stock: 0 }]);
  assert.match(html, /<span class="price">\$12\.50<\/span>/);
  assert.match(html, /&lt;Pot&gt;.*Sold out/);
});
