import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../../src/duration.js";

test("single units", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("2m"), 120);
  assert.equal(parseDuration("3h"), 10800);
  assert.equal(parseDuration("1d"), 86400);
  assert.equal(parseDuration("0s"), 0);
});
test("combined", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("2d4h"), 187200);
  assert.equal(parseDuration("1d2h3m4s"), 93784);
  assert.equal(parseDuration("90m"), 5400);
});
test("rejects bad input", () => {
  for (const bad of ["", "5", "h", "1x", "1m1h", "1h1h", "1h 30m", " 1h", "1.5h", "-1h", "1H"]) {
    assert.throws(() => parseDuration(bad), Error, `should reject ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, undefined, 5, {}]) assert.throws(() => parseDuration(bad), Error);
});
