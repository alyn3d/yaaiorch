import { test } from "node:test";
import assert from "node:assert/strict";
import { sortBy } from "../../src/sort.js";

const people = () => [
  { n: "bob", age: 30, i: 0 },
  { n: "Alice", age: 25, i: 1 },
  { n: "alice", age: 40, i: 2 },
  { n: "carl", age: null, i: 3 },
  { n: "dave", i: 4 },
  { n: "Bob", age: 30, i: 5 },
];
const order = (xs) => xs.map((x) => x.i);

test("strings: case-insensitive and stable", () => {
  assert.deepEqual(order(sortBy(people(), "n")), [1, 2, 0, 5, 3, 4]);
  assert.deepEqual(order(sortBy(people(), "n:asc")), [1, 2, 0, 5, 3, 4]);
});

test("several keys, desc, nulls last", () => {
  assert.deepEqual(order(sortBy(people(), "age:desc,n")), [2, 0, 5, 1, 3, 4]);
  assert.deepEqual(order(sortBy(people(), "age")), [1, 0, 5, 2, 3, 4]);
  assert.deepEqual(sortBy([{ v: 1 }, { v: null }, { v: 3 }, { v: undefined }, { v: 2 }], "v:desc").slice(0, 3).map((x) => x.v), [3, 2, 1]);
  assert.deepEqual(sortBy([{ v: null }, { v: 2 }, { v: 1 }], "v").map((x) => x.v), [1, 2, null]);
});

test("numbers are numeric, strings are numeric-aware", () => {
  assert.deepEqual(sortBy([{ v: 10 }, { v: 9 }, { v: 100 }], "v").map((x) => x.v), [9, 10, 100]);
  const files = [{ f: "file10", i: 0 }, { f: "file2", i: 1 }, { f: "File1", i: 2 }, { f: "file1", i: 3 }];
  assert.deepEqual(sortBy(files, "f").map((x) => x.f), ["File1", "file1", "file2", "file10"]);
});

test("returns a new array and leaves the input alone", () => {
  const input = people();
  const copy = JSON.stringify(input);
  const out = sortBy(input, "n:desc");
  assert.notEqual(out, input);
  assert.equal(JSON.stringify(input), copy);
  assert.deepEqual(order(out), [4, 3, 0, 5, 1, 2]);
  assert.deepEqual(out.map((x) => x.n.toLowerCase()), ["dave", "carl", "bob", "bob", "alice", "alice"]);
  assert.deepEqual(order(out).slice(2, 6), [0, 5, 1, 2], "ties keep their original order in desc too");
});

test("bad specs throw", () => {
  assert.throws(() => sortBy(people(), ""), Error);
  assert.throws(() => sortBy(people(), "n:up"), Error);
});
