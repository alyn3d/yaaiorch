import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrences } from "../../src/recurrence.js";

test("daily with an interval, across a leap day", () => {
  assert.deepEqual(nextOccurrences({ start: "2024-02-27", freq: "daily", interval: 3 }, "2024-02-27", 4), [
    "2024-02-27",
    "2024-03-01",
    "2024-03-04",
    "2024-03-07",
  ]);
});

test("from after the start keeps the start's rhythm; from before the start begins at the start", () => {
  assert.deepEqual(nextOccurrences({ start: "2026-01-01", freq: "daily", interval: 7 }, "2026-01-03", 2), ["2026-01-08", "2026-01-15"]);
  assert.deepEqual(nextOccurrences({ start: "2026-05-10", freq: "daily" }, "2026-01-01", 1), ["2026-05-10"]);
});

test("weekly: weeks run Monday to Sunday, counted from the start's week", () => {
  // 2026-11-18 is a Wednesday; its week is Mon 16 to Sun 22.
  assert.deepEqual(nextOccurrences({ start: "2026-11-18", freq: "weekly", interval: 2, byWeekday: [1, 3, 0] }, "2026-11-01", 5), [
    "2026-11-18",
    "2026-11-22",
    "2026-11-30",
    "2026-12-02",
    "2026-12-06",
  ]);
  assert.deepEqual(nextOccurrences({ start: "2026-11-18", freq: "weekly" }, "2026-11-18", 2), ["2026-11-18", "2026-11-25"]);
});

test("monthly: a missing day is skipped, -1 is the last day, the default is the start's day", () => {
  assert.deepEqual(nextOccurrences({ start: "2026-01-31", freq: "monthly", byMonthDay: 31 }, "2026-01-01", 4), [
    "2026-01-31",
    "2026-03-31",
    "2026-05-31",
    "2026-07-31",
  ]);
  assert.deepEqual(nextOccurrences({ start: "2024-01-15", freq: "monthly", byMonthDay: -1 }, "2024-01-01", 3), ["2024-01-31", "2024-02-29", "2024-03-31"]);
  assert.deepEqual(nextOccurrences({ start: "2026-01-30", freq: "monthly" }, "2026-01-01", 3), ["2026-01-30", "2026-03-30", "2026-04-30"]);
});

test("a rule that can never occur returns an empty list; count 0 too", () => {
  assert.deepEqual(nextOccurrences({ start: "2026-02-01", freq: "monthly", interval: 12, byMonthDay: 30 }, "2026-02-01", 3), []);
  assert.deepEqual(nextOccurrences({ start: "2026-02-01", freq: "daily" }, "2026-02-01", 0), []);
});

test("invalid arguments", () => {
  for (const bad of [null, undefined, "daily", [], 3]) assert.throws(() => nextOccurrences(bad, "2026-01-01", 1), TypeError, String(bad));
  const ok = { start: "2026-01-01", freq: "daily" };
  const rangeErrors = [
    [{ ...ok, start: "2026-02-30" }, "2026-01-01", 1],
    [{ ...ok, start: "2026-1-01" }, "2026-01-01", 1],
    [ok, "2026-13-01", 1],
    [ok, 20260101, 1],
    [{ ...ok, freq: "yearly" }, "2026-01-01", 1],
    [{ ...ok, interval: 0 }, "2026-01-01", 1],
    [{ ...ok, interval: 1.5 }, "2026-01-01", 1],
    [{ ...ok, interval: "2" }, "2026-01-01", 1],
    [ok, "2026-01-01", -1],
    [ok, "2026-01-01", 1001],
    [ok, "2026-01-01", 1.5],
    [{ ...ok, byWeekday: [1] }, "2026-01-01", 1],
    [{ ...ok, freq: "weekly", byMonthDay: 1 }, "2026-01-01", 1],
    [{ ...ok, freq: "weekly", byWeekday: [] }, "2026-01-01", 1],
    [{ ...ok, freq: "weekly", byWeekday: [7] }, "2026-01-01", 1],
    [{ ...ok, freq: "weekly", byWeekday: [1, 1] }, "2026-01-01", 1],
    [{ ...ok, freq: "monthly", byMonthDay: 0 }, "2026-01-01", 1],
    [{ ...ok, freq: "monthly", byMonthDay: 32 }, "2026-01-01", 1],
    [{ ...ok, freq: "monthly", byMonthDay: -2 }, "2026-01-01", 1],
  ];
  for (const args of rangeErrors) assert.throws(() => nextOccurrences(...args), RangeError, JSON.stringify(args));
});
