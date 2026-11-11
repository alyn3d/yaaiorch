import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../../src/array.js";

test("keeps the last partial group", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2, 3], 5), [[1, 2, 3]]);
  assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
});
test("even split and empty input", () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assert.deepEqual(chunk([], 3), []);
});
test("size must be a positive integer", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => chunk([1, 2], bad), RangeError, String(bad));
});
