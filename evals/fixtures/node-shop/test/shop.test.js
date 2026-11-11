import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart, placeOrder, listOrders, salesReport, getProduct, tax, formatMoney } from "../src/index.js";

test("pricing", () => {
  assert.equal(tax(1000), 80);
  assert.equal(tax(1299), 104);
  assert.equal(formatMoney(1234), "$12.34");
});

test("cart lines and subtotal", () => {
  const cart = new Cart();
  cart.add("TEA-01", 2);
  cart.add("PEN-01");
  assert.equal(cart.subtotal(), 2 * 450 + 199);
  cart.remove("PEN-01");
  assert.deepEqual(cart.items(), [{ sku: "TEA-01", name: "Green tea", qty: 2, unitPrice: 450, lineTotal: 900 }]);
  assert.throws(() => cart.add("NOPE"), /unknown sku/);
  assert.throws(() => cart.add("TEA-01", 0), RangeError);
});

test("orders take stock and add tax; report sums them", () => {
  const before = getProduct("MUG-01").stock;
  const cart = new Cart();
  cart.add("MUG-01", 2);
  const order = placeOrder(cart);
  assert.equal(order.subtotal, 2598);
  assert.equal(order.tax, 208);
  assert.equal(order.total, 2806);
  assert.equal(getProduct("MUG-01").stock, before - 2);

  const big = new Cart();
  big.add("MUG-01", 99);
  assert.throws(() => placeOrder(big), /not enough stock/);
  assert.throws(() => placeOrder(new Cart()), /empty/);

  const report = salesReport(listOrders());
  assert.equal(report.count, 1);
  assert.equal(report.revenue, 2806);
  assert.deepEqual(report.bySku, { "MUG-01": 2 });
});
