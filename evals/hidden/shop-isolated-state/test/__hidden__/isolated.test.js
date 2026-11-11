import { test } from "node:test";
import assert from "node:assert/strict";
import { createShop } from "../../src/shop.js";
import * as legacy from "../../src/index.js";

test("two default shops have independent stock and order ids", () => {
  const a = createShop();
  const b = createShop();
  const ca = a.newCart();
  ca.add("MUG-01", 5);
  const oa = a.placeOrder(ca);
  assert.equal(oa.id, 1);
  assert.equal(a.getProduct("MUG-01").stock, 0);
  assert.equal(b.getProduct("MUG-01").stock, 5);

  const cb = b.newCart();
  cb.add("MUG-01", 2);
  assert.equal(b.placeOrder(cb).id, 1);
  assert.equal(a.listOrders().length, 1);
  assert.equal(b.listOrders().length, 1);

  const more = a.newCart();
  more.add("MUG-01", 1);
  assert.throws(() => a.placeOrder(more), /not enough stock/);
  const next = a.newCart();
  next.add("TEA-01", 1);
  assert.equal(a.placeOrder(next).id, 2);
});

test("custom products", () => {
  const s = createShop({ "X-1": { name: "Thing", price: 1000, stock: 2 } });
  assert.deepEqual(s.listProducts(), [{ sku: "X-1", name: "Thing", price: 1000, stock: 2 }]);
  const c = s.newCart();
  c.add("X-1", 2);
  const o = s.placeOrder(c);
  assert.equal(o.subtotal, 1000 * 2);
  assert.equal(o.total, 2160);
  assert.throws(() => s.newCart().add("MUG-01", 1), /unknown sku/);
  assert.deepEqual(s.salesReport(), { count: 1, revenue: 2160, bySku: { "X-1": 2 } });
});

test("shops built from the same products object do not share stock", () => {
  const products = { "X-1": { name: "Thing", price: 500, stock: 3 } };
  const s1 = createShop(products);
  const s2 = createShop(products);
  const c = s1.newCart();
  c.add("X-1", 3);
  s1.placeOrder(c);
  assert.equal(s1.getProduct("X-1").stock, 0);
  assert.equal(s2.getProduct("X-1").stock, 3);
});

test("the old module API still works and is not affected by created shops", () => {
  const fresh = createShop();
  const c = new legacy.Cart();
  c.add("PEN-01", 2);
  const o = legacy.placeOrder(c);
  assert.equal(o.id, 1);
  assert.equal(o.total, 398 + 32);
  assert.equal(legacy.getProduct("PEN-01").stock, 98);
  assert.equal(fresh.getProduct("PEN-01").stock, 100);
  assert.equal(createShop().getProduct("PEN-01").stock, 100, "new shops start from the standard catalog, not the default shop's stock");
  assert.equal(legacy.listOrders().length, 1);
  assert.deepEqual(legacy.salesReport(legacy.listOrders()).bySku, { "PEN-01": 2 });
});
