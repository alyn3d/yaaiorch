import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as array from "../../src/array.js";
import { mean } from "../../src/stats.js";

test("total is exported and works", () => {
  assert.equal(typeof array.total, "function");
  assert.equal(array.total([1, 2, 3]), 6);
  assert.equal(array.total([]), 0);
});
test("sum is a deprecated alias", () => {
  assert.equal(typeof array.sum, "function");
  assert.equal(array.sum([4, 5]), 9);
  assert.match(readFileSync(new URL("../../src/array.js", import.meta.url), "utf8"), /@deprecated/);
});
test("internal callers use total", () => {
  const stats = readFileSync(new URL("../../src/stats.js", import.meta.url), "utf8");
  assert.doesNotMatch(stats, /\bsum\b/);
  assert.match(stats, /\btotal\b/);
  assert.equal(mean([2, 4]), 3);
});
