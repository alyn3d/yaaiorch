import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart, placeOrder, listOrders, salesReport } from "../../src/index.js";

test("adding the same sku twice adds the quantities", () => {
  const c = new Cart();
  c.add("MUG-01", 2);
  c.add("MUG-01", 1);
  assert.equal(c.items().length, 1);
  assert.equal(c.items()[0].qty, 3);
  assert.equal(c.subtotal(), 3897);
});

test("the report and the order total reflect all units", () => {
  const c = new Cart();
  c.add("MUG-01", 2);
  c.add("MUG-01", 1);
  const order = placeOrder(c);
  assert.equal(order.subtotal, 3897);
  assert.equal(order.total, 3897 + 312);
  assert.deepEqual(salesReport(listOrders()).bySku, { "MUG-01": 3 });
});

test("remove then add starts again; validation still applies", () => {
  const c = new Cart();
  c.add("TEA-01", 2);
  c.remove("TEA-01");
  c.add("TEA-01");
  assert.equal(c.items()[0].qty, 1);
  c.add("PEN-01", 4);
  c.add("PEN-01", 6);
  assert.equal(c.items().find((l) => l.sku === "PEN-01").qty, 10);
  assert.throws(() => c.add("TEA-01", 0), RangeError);
  assert.throws(() => c.add("NOPE", 1), /unknown sku/);
  assert.equal(c.items().find((l) => l.sku === "TEA-01").qty, 1, "a rejected add changes nothing");
});
