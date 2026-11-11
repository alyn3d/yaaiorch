import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart, placeOrder, listOrders, salesReport } from "../../src/index.js";

test("SAVE10 takes 10% off, rounded half up", () => {
  const c = new Cart();
  c.add("TEA-01", 3); // 1350
  assert.equal(c.coupon(), null);
  assert.equal(c.discount(), 0);
  c.applyCoupon("SAVE10");
  assert.equal(c.coupon(), "SAVE10");
  assert.equal(c.discount(), 135);

  const pens = new Cart();
  pens.add("PEN-01", 5); // 995 -> 99.5 -> 100
  pens.applyCoupon("SAVE10");
  assert.equal(pens.discount(), 100);
});

test("FLAT500 needs a subtotal of at least 2000", () => {
  const c = new Cart();
  c.add("TEA-01", 4); // 1800
  c.applyCoupon("FLAT500");
  assert.equal(c.discount(), 0);
  c.add("MUG-01", 1); // 3099
  assert.equal(c.discount(), 500);

  const exact = new Cart();
  exact.add("PEN-01", 10); // 1990
  exact.applyCoupon("FLAT500");
  assert.equal(exact.discount(), 0);
});

test("one coupon per cart; unknown codes throw", () => {
  const c = new Cart();
  c.add("TEA-01", 5); // 2250
  c.applyCoupon("SAVE10");
  c.applyCoupon("FLAT500");
  assert.equal(c.coupon(), "FLAT500");
  assert.equal(c.discount(), 500);
  assert.throws(() => c.applyCoupon("FREE100"), Error);
});

test("orders apply tax after the discount, and the report adds discounts", () => {
  const a = new Cart();
  a.add("TEA-01", 2); // 900
  a.add("PEN-01", 5); // 995 -> subtotal 1895
  a.applyCoupon("SAVE10"); // 189.5 -> 190
  const o1 = placeOrder(a);
  assert.equal(o1.subtotal, 1895);
  assert.equal(o1.discount, 190);
  assert.equal(o1.tax, 136); // 8% of 1705 = 136.4
  assert.equal(o1.total, 1841);
  assert.equal(o1.coupon, "SAVE10");

  const b = new Cart();
  b.add("MUG-01", 1);
  const o2 = placeOrder(b);
  assert.equal(o2.discount, 0);
  assert.equal(o2.coupon, null);
  assert.equal(o2.tax, 104);
  assert.equal(o2.total, 1403);

  const c = new Cart();
  c.add("TEA-01", 5); // 2250
  c.applyCoupon("FLAT500");
  const o3 = placeOrder(c);
  assert.equal(o3.discount, 500);
  assert.equal(o3.tax, 140); // 8% of 1750
  assert.equal(o3.total, 1890);

  const r = salesReport(listOrders());
  assert.equal(r.count, 3);
  assert.equal(r.revenue, 1841 + 1403 + 1890);
  assert.equal(r.discounts, 690);
  assert.deepEqual(r.byCoupon, { SAVE10: 1, FLAT500: 1 });
  assert.deepEqual(r.bySku, { "TEA-01": 7, "PEN-01": 5, "MUG-01": 1 });
  assert.deepEqual(salesReport([]).byCoupon, {});
  assert.equal(salesReport([]).discounts, 0);
});
