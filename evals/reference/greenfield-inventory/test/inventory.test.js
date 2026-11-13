import { test } from "node:test";
import assert from "node:assert/strict";
import { Inventory } from "../src/inventory.js";

test("add and remove", () => {
  const inv = new Inventory();
  inv.add("abc", 2);
  assert.equal(inv.remove("ABC", 1), 1);
  assert.equal(inv.total(), 1);
});
