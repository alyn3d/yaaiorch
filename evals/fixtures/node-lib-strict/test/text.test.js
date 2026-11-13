import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize, words } from "../src/text.js";

test("capitalize", () => {
  assert.equal(capitalize("hello"), "Hello");
  assert.equal(capitalize(""), "");
});

test("words", () => {
  assert.deepEqual(words("  a  b\tc\n"), ["a", "b", "c"]);
});
