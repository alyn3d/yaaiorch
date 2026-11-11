import { test } from "node:test";
import assert from "node:assert/strict";
import { mean, range } from "../src/stats.js";

test("mean", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(mean([]), 0);
});

test("range", () => {
  assert.equal(range([3, 9, 1]), 8);
  assert.equal(range([]), 0);
});
