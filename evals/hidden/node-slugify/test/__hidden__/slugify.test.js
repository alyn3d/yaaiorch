import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../../src/slugify.js";

test("basic", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Trim me  "), "trim-me");
});
test("collapses runs of other characters", () => {
  assert.equal(slugify("a  --  b"), "a-b");
  assert.equal(slugify("C'est la vie!"), "c-est-la-vie");
  assert.equal(slugify("v2.0_beta"), "v2-0-beta");
});
test("strips edge hyphens", () => {
  assert.equal(slugify("--x--"), "x");
  assert.equal(slugify("!!!"), "");
  assert.equal(slugify(""), "");
});
test("accents", () => {
  assert.equal(slugify("Crème Brûlée"), "creme-brulee");
  assert.equal(slugify("Ñandú"), "nandu");
});
