import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "../../src/lru.js";

test("capacity must be a positive integer", () => {
  for (const bad of [0, -1, 1.5, NaN, "2"]) assert.throws(() => new LRUCache(bad), RangeError, String(bad));
});
test("get, set, size", () => {
  const c = new LRUCache(2);
  assert.equal(c.get("a"), undefined);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  assert.equal(c.size, 2);
  c.set("a", 10);
  assert.equal(c.get("a"), 10);
  assert.equal(c.size, 2);
});
test("evicts least recently used, get refreshes", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.has("b"), false);
  assert.equal(c.has("a"), true);
  assert.equal(c.has("c"), true);
});
test("set on an existing key refreshes it", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 3);
  c.set("c", 4);
  assert.equal(c.has("b"), false);
  assert.equal(c.get("a"), 3);
});
test("has does not refresh", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.has("a");
  c.set("c", 3);
  assert.equal(c.has("a"), false);
});
test("delete", () => {
  const c = new LRUCache(1);
  c.set("a", 1);
  assert.equal(c.delete("a"), true);
  assert.equal(c.delete("a"), false);
  assert.equal(c.size, 0);
  c.set("x", undefined);
  assert.equal(c.has("x"), true);
});
