import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals, subtractIntervals } from "../../src/intervals.js";

test("merge: overlapping and touching intervals, any order", () => {
  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(
    mergeIntervals([
      [5, 7],
      [1, 3],
      [2, 4],
    ]),
    [
      [1, 4],
      [5, 7],
    ],
  );
  assert.deepEqual(
    mergeIntervals([
      [3, 5],
      [1, 3],
    ]),
    [[1, 5]],
  );
  assert.deepEqual(
    mergeIntervals([
      [1, 10],
      [2, 3],
      [4, 5],
    ]),
    [[1, 10]],
  );
  assert.deepEqual(
    mergeIntervals([
      [0.5, 1.5],
      [-2, -1],
    ]),
    [
      [-2, -1],
      [0.5, 1.5],
    ],
  );
});

test("merge does not change its argument and returns new intervals", () => {
  const input = [
    [3, 4],
    [1, 2],
    [2, 3],
  ];
  const copy = JSON.parse(JSON.stringify(input));
  const out = mergeIntervals(input);
  assert.deepEqual(input, copy);
  out[0][0] = 99;
  assert.deepEqual(input, copy);
});

test("subtract: holes, full cover, touching edges, unsorted inputs", () => {
  assert.deepEqual(subtractIntervals([[0, 10]], [[3, 5]]), [
    [0, 3],
    [5, 10],
  ]);
  assert.deepEqual(subtractIntervals([[0, 10]], [[-5, 20]]), []);
  assert.deepEqual(subtractIntervals([[0, 10]], [[10, 12]]), [[0, 10]]);
  assert.deepEqual(
    subtractIntervals(
      [
        [5, 8],
        [0, 3],
        [2, 6],
      ],
      [
        [4, 5],
        [1, 2],
      ],
    ),
    [
      [0, 1],
      [2, 4],
      [5, 8],
    ],
  );
  assert.deepEqual(subtractIntervals([], [[1, 2]]), []);
  assert.deepEqual(
    subtractIntervals(
      [
        [0, 2],
        [2, 4],
      ],
      [],
    ),
    [[0, 4]],
  );
});

test("subtract does not change its arguments", () => {
  const a = [
    [0, 5],
    [6, 9],
  ];
  const b = [[1, 7]];
  subtractIntervals(a, b);
  assert.deepEqual(a, [
    [0, 5],
    [6, 9],
  ]);
  assert.deepEqual(b, [[1, 7]]);
});

test("invalid input", () => {
  for (const f of [(x) => mergeIntervals(x), (x) => subtractIntervals(x, []), (x) => subtractIntervals([], x)]) {
    for (const bad of [null, undefined, "[]", { length: 0 }]) assert.throws(() => f(bad), TypeError, String(bad));
    for (const bad of [[[1]], [[2, 1]], [[1, 1]], [[0, Infinity]], [[NaN, 1]], [["0", 1]], [null], [[1, 2, 3]]])
      assert.throws(() => f(bad), RangeError, JSON.stringify(bad));
  }
});
