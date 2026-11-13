import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Inventory, InsufficientStockError } from "../../src/inventory.js";

test("the project was set up as asked", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.type, "module");
  assert.match(pkg.scripts?.test ?? "", /node --test/);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

test("add and quantity; SKUs are trimmed and upper-cased", () => {
  const inv = new Inventory();
  assert.equal(inv.quantity("abc-1"), 0);
  assert.equal(inv.add(" abc-1 ", 3), 3);
  assert.equal(inv.add("ABC-1", 2), 5);
  assert.equal(inv.quantity("abc-1"), 5);
});

test("invalid SKUs are a TypeError, invalid quantities a RangeError", () => {
  const inv = new Inventory();
  for (const bad of ["", "  ", "ab", "A".repeat(21), "AB_1", "AB 12", 42, null, undefined]) assert.throws(() => inv.add(bad, 1), TypeError, String(bad));
  assert.doesNotThrow(() => inv.add("A".repeat(20), 1));
  for (const bad of [0, -1, 1.5, NaN, Infinity, "2"]) {
    assert.throws(() => inv.add("ABC", bad), RangeError, String(bad));
    assert.throws(() => inv.remove("ABC", bad), RangeError, String(bad));
  }
  assert.throws(() => inv.remove("a b", 1), TypeError);
  assert.equal(inv.quantity("ABC"), 0, "a rejected add changes nothing");
});

test("remove: returns what is left; an emptied SKU disappears from the list", () => {
  const inv = new Inventory();
  inv.add("x-100", 5);
  assert.equal(inv.remove("X-100", 2), 3);
  assert.equal(inv.remove("x-100", 3), 0);
  assert.deepEqual(inv.list(), []);
  assert.equal(inv.quantity("X-100"), 0);
});

test("removing more than the stock throws InsufficientStockError and changes nothing", () => {
  const inv = new Inventory();
  inv.add("KEY", 2);
  let err;
  try {
    inv.remove("key", 5);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof InsufficientStockError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "InsufficientStockError");
  assert.deepEqual([err.sku, err.requested, err.available], ["KEY", 5, 2]);
  assert.equal(inv.quantity("KEY"), 2);
  assert.throws(() => inv.remove("NONE", 1), (e) => e instanceof InsufficientStockError && e.available === 0);
});

test("list is sorted by SKU and returns copies; total sums the stock", () => {
  const inv = new Inventory();
  inv.add("b-2", 1);
  inv.add("A-10", 4);
  inv.add("a-2", 2);
  const l = inv.list();
  assert.deepEqual(l, [
    { sku: "A-10", qty: 4 },
    { sku: "A-2", qty: 2 },
    { sku: "B-2", qty: 1 },
  ]);
  l[0].qty = 999;
  l.push({ sku: "Z", qty: 1 });
  assert.equal(inv.quantity("A-10"), 4);
  assert.equal(inv.list().length, 3);
  assert.equal(inv.total(), 7);
  assert.equal(new Inventory().total(), 0);
});
