import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, sum } from "../src/array.js";

test("chunk splits evenly", () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("sum adds numbers", () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
});
