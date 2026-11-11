import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart, placeOrder, listOrders, salesReport, getProduct, refund } from "../../src/index.js";

test("partial refunds: amounts, tax shares, the exact remainder, stock", () => {
  const cart = new Cart();
  cart.add("TEA-01", 3); // 1350
  cart.add("PEN-01", 5); // 995
  const order = placeOrder(cart); // subtotal 2345, tax 188 (187.6), total 2533
  assert.equal(order.tax, 188);
  assert.deepEqual(order.refunds, []);
  assert.equal(order.refunded, 0);
  const teaStock = getProduct("TEA-01").stock;
  const penStock = getProduct("PEN-01").stock;

  // 188 * 450 / 2345 = 36.08 -> 36
  assert.deepEqual(refund(order.id, "TEA-01", 1), { sku: "TEA-01", qty: 1, amount: 486 });
  assert.equal(getProduct("TEA-01").stock, teaStock + 1);
  // 188 * 995 / 2345 = 79.77 -> 80
  assert.deepEqual(refund(order.id, "PEN-01", 5), { sku: "PEN-01", qty: 5, amount: 1075 });
  assert.equal(getProduct("PEN-01").stock, penStock + 5);
  // Last units of the whole order: the rest of the tax, 188 - 36 - 80 = 72
  assert.deepEqual(refund(order.id, "TEA-01", 2), { sku: "TEA-01", qty: 2, amount: 972 });

  const stored = listOrders().find((o) => o.id === order.id);
  assert.equal(stored.refunded, 2533, "a fully refunded order gives back exactly its total");
  assert.deepEqual(stored.refunds.map((r) => r.amount), [486, 1075, 972]);
});

test("tax shares round half up; the last refund takes the remainder", () => {
  const cart = new Cart();
  cart.add("PEN-01", 8); // 1592, tax 127 (127.36)
  const order = placeOrder(cart);
  // 127 * 796 / 1592 = 63.5 -> 64
  assert.equal(refund(order.id, "PEN-01", 4).amount, 796 + 64);
  // the rest of the tax: 127 - 64 = 63
  assert.equal(refund(order.id, "PEN-01", 4).amount, 796 + 63);

  const mugs = new Cart();
  mugs.add("MUG-01", 2); // 2598, tax 208
  const o2 = placeOrder(mugs);
  assert.equal(refund(o2.id, "MUG-01", 1).amount, 1299 + 104);
  assert.equal(refund(o2.id, "MUG-01", 1).amount, 1299 + 104);
});

test("invalid refunds throw and change nothing", () => {
  const cart = new Cart();
  cart.add("TEA-01", 2);
  const order = placeOrder(cart);
  const stock = getProduct("TEA-01").stock;
  refund(order.id, "TEA-01", 1);
  assert.throws(() => refund(order.id, "TEA-01", 2), Error, "more than left");
  assert.throws(() => refund(order.id, "PEN-01", 1), Error, "sku not in the order");
  assert.throws(() => refund(order.id, "TEA-01", 0), Error, "qty 0");
  assert.throws(() => refund(order.id, "TEA-01", 1.5), Error, "qty not an integer");
  assert.throws(() => refund(9999, "TEA-01", 1), Error, "unknown order");
  assert.equal(getProduct("TEA-01").stock, stock + 1);
  assert.equal(listOrders().find((o) => o.id === order.id).refunds.length, 1);
});

test("the report shows refunds, net revenue and net units", () => {
  const r = salesReport(listOrders());
  const revenue = listOrders().reduce((s, o) => s + o.total, 0);
  const refunds = listOrders().reduce((s, o) => s + o.refunded, 0);
  assert.equal(r.revenue, revenue);
  assert.equal(r.refunds, refunds);
  assert.equal(r.netRevenue, revenue - refunds);
  // Bought: TEA 3+2, PEN 5+8, MUG 2. Refunded: TEA 3+1, PEN 5+8, MUG 2.
  assert.equal(r.bySku["TEA-01"], 1);
  assert.equal(r.bySku["PEN-01"] ?? 0, 0);
  assert.equal(r.bySku["MUG-01"] ?? 0, 0);
  assert.equal(salesReport([]).refunds, 0);
  assert.equal(salesReport([]).netRevenue, 0);
});
