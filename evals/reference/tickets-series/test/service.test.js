import { test } from "node:test";
import assert from "node:assert/strict";
import { makeService } from "./helpers.js";
import { ValidationError, NotFoundError, ConflictError } from "../src/errors.js";

test("create fills defaults and the clock time", () => {
  const s = makeService();
  const t = s.create({ title: "  Printer jam " });
  assert.deepEqual(t, { id: 1, title: "Printer jam", priority: "normal", status: "open", assignee: null, tags: [], createdAt: "2026-03-02T10:00:00.000Z" });
  assert.equal(s.create({ title: "b", priority: "urgent", assignee: "ana" }).id, 2);
});

test("validation", () => {
  const s = makeService();
  assert.throws(() => s.create({ title: "" }), ValidationError);
  assert.throws(() => s.create({ title: "x", priority: "huge" }), ValidationError);
  assert.throws(() => s.create({ title: "x", assignee: "Not Valid" }), ValidationError);
  assert.throws(() => s.get(9), NotFoundError);
});

test("list filters, assign, close", () => {
  const s = makeService();
  s.create({ title: "a", assignee: "ana" });
  s.create({ title: "b" });
  s.assign(2, "bo");
  s.close(1);
  assert.deepEqual(s.list({ status: "open" }).map((t) => t.id), [2]);
  assert.deepEqual(s.list({ assignee: "bo" }).map((t) => t.id), [2]);
  assert.throws(() => s.close(1), ConflictError);
  assert.throws(() => s.list({ status: "weird" }), ValidationError);
});
