// Gate suite for lib-recurrence-fuzz: run by orch after the repo's own checks pass; the agents cannot run or read it.
// 3,000 seeded random rules compared with a day-by-day oracle, smallest counts first, in a worker so that a call that
// never returns (a rule that can never occur) fails the gate instead of hanging it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { jsdocProblems } from "./house-rules.mjs";

const CASES = 3000;
const LIMIT_MS = 60_000;

const worker = `
const { parentPort, workerData } = require("node:worker_threads");
const DAY = 86400000;
function rng(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(7);
const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (xs) => xs[int(0, xs.length - 1)];
const iso = (date) => date.toISOString().slice(0, 10);
const utc = (s) => new Date(s + "T00:00:00Z");

/** Oracle: walk the calendar one day at a time with Date objects. */
function oracle(rule, from, count) {
  const start = utc(rule.start);
  const interval = rule.interval ?? 1;
  const end = Date.UTC(start.getUTCFullYear() + 100, 0, 1);
  const out = [];
  const startMonday = start.getTime() - ((start.getUTCDay() + 6) % 7) * DAY;
  for (let d = new Date(Math.max(start.getTime(), utc(from).getTime())); d.getTime() < end && out.length < count; d = new Date(d.getTime() + DAY)) {
    let ok;
    if (rule.freq === "daily") ok = Math.round((d - start) / DAY) % interval === 0;
    else if (rule.freq === "weekly") {
      const days = rule.byWeekday ?? [start.getUTCDay()];
      const monday = d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
      ok = days.includes(d.getUTCDay()) && Math.round((monday - startMonday) / (7 * DAY)) % interval === 0;
    } else {
      const md = rule.byMonthDay ?? start.getUTCDate();
      const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      ok = months % interval === 0 && (md === -1 ? d.getUTCDate() === last : d.getUTCDate() === md);
    }
    if (ok) out.push(iso(d));
  }
  return out;
}

function randomRule(i) {
  const start = new Date(Date.UTC(int(1999, 2031), 0, 1) + int(0, 364) * DAY);
  const freq = pick(["daily", "weekly", "monthly"]);
  const rule = { start: iso(start), freq };
  if (r() < 0.7) rule.interval = r() < 0.15 ? pick([12, 13]) : int(1, 4);
  if (freq === "weekly" && r() < 0.75) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter(() => r() < 0.35);
    rule.byWeekday = days.length ? days.sort(() => r() - 0.5) : [int(0, 6)];
  }
  if (freq === "monthly" && r() < 0.8) rule.byMonthDay = r() < 0.5 ? pick([28, 29, 30, 31, -1]) : int(1, 31);
  // Now and then a rule that can never occur: the 31st, every 12 months, starting in a 30-day month.
  if (i % 60 === 0) {
    const never = { start: iso(new Date(Date.UTC(int(1999, 2031), pick([3, 5, 8, 10]), 1))), freq: "monthly", interval: 12, byMonthDay: 31 };
    return { rule: never, from: never.start };
  }
  return { rule, from: iso(new Date(start.getTime() + int(-400, 400) * DAY)) };
}

import(workerData.url).then((m) => {
  const cases = Array.from({ length: workerData.n }, (_, i) => ({ ...randomRule(i), count: Math.min(12, Math.floor(i / 150)) }));
  for (const { rule, from, count } of cases) {
    const want = oracle(rule, from, count);
    let got;
    try { got = m.nextOccurrences(JSON.parse(JSON.stringify(rule)), from, count); }
    catch (e) { return parentPort.postMessage({ rule, from, count, want, error: String(e) }); }
    if (JSON.stringify(got) !== JSON.stringify(want)) return parentPort.postMessage({ rule, from, count, want, got });
  }
  parentPort.postMessage("ok");
}, (e) => parentPort.postMessage({ load: String(e) }));
`;

/** Runs `code` (CommonJS, sees `m`: the repo's module) in a worker; resolves its message, or "timeout". */
function inWorker(code, data, ms) {
  return new Promise((done) => {
    const src = `const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.url).then((m) => { ${code} }, (e) => parentPort.postMessage({ load: String(e) }));`;
    const w = new Worker(src, { eval: true, workerData: { url: pathToFileURL(resolve("src/recurrence.js")).href, ...data } });
    const timer = setTimeout(() => {
      w.terminate();
      done("timeout");
    }, ms);
    w.on("message", (m) => {
      clearTimeout(timer);
      w.terminate();
      done(m);
    });
    w.on("error", (e) => {
      clearTimeout(timer);
      done({ load: String(e) });
    });
  });
}

test("house rules: JSDoc with @param and @returns on every export of src/recurrence.js", () => {
  const problems = jsdocProblems("src/recurrence.js");
  assert.ok(!problems.length, `exported functions need a JSDoc block with @param for each parameter and @returns:\n- ${problems.join("\n- ")}`);
});

test("house rules: error messages name the function and the bad field", async () => {
  const ok = { start: "2026-01-01", freq: "daily" };
  const cases = [
    [[null, "2026-01-01", 1], "TypeError", "rule"],
    [[{ ...ok, start: "2026-02-30" }, "2026-01-01", 1], "RangeError", "start"],
    [[ok, "2026-13-01", 1], "RangeError", "from"],
    [[{ ...ok, freq: "yearly" }, "2026-01-01", 1], "RangeError", "freq"],
    [[{ ...ok, interval: 0 }, "2026-01-01", 1], "RangeError", "interval"],
    [[ok, "2026-01-01", -1], "RangeError", "count"],
    [[{ ...ok, freq: "weekly", byWeekday: [7] }, "2026-01-01", 1], "RangeError", "byWeekday"],
    [[{ ...ok, byMonthDay: 1 }, "2026-01-01", 1], "RangeError", "byMonthDay"],
  ];
  const code = `
    const out = workerData.cases.map(([args]) => {
      try { m.nextOccurrences(...args); return null; } catch (e) { return [e && e.name, String(e && e.message)]; }
    });
    parentPort.postMessage(out);`;
  const r = await inWorker(code, { cases }, 10_000);
  assert.notEqual(r, "timeout", "a call with invalid input did not return");
  if (r.load) assert.fail(`could not load src/recurrence.js: ${r.load}`);
  const problems = cases.flatMap(([args, type, field], i) => {
    const call = `nextOccurrences(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    const prefix = `nextOccurrences: ${field}`;
    if (!r[i]) return [`${call} did not throw`];
    if (r[i][0] !== type) return [`${call} threw ${r[i][0]}; expected a ${type}`];
    return new RegExp(`^${prefix}\\b`).test(r[i][1]) ? [] : [`${call} threw "${r[i][1]}"; the message must start with "${prefix}"`];
  });
  assert.ok(!problems.length, `error messages must start with the function name and a colon, then name the bad field:\n- ${problems.join("\n- ")}`);
});

test(`nextOccurrences matches the oracle on ${CASES.toLocaleString("en")} random rules (smallest counts first)`, async () => {
  const result = await new Promise((done) => {
    const w = new Worker(worker, { eval: true, workerData: { url: pathToFileURL(resolve("src/recurrence.js")).href, n: CASES } });
    const timer = setTimeout(() => {
      w.terminate();
      done("hang");
    }, LIMIT_MS);
    w.on("message", (m) => {
      clearTimeout(timer);
      w.terminate();
      done(m);
    });
    w.on("error", (e) => {
      clearTimeout(timer);
      done({ load: String(e) });
    });
  });
  assert.notEqual(result, "hang", "nextOccurrences did not return for some rule (a rule that can never occur must still return)");
  if (result !== "ok") {
    if (result.load) assert.fail(`could not load src/recurrence.js: ${result.load}`);
    const call = `nextOccurrences(${JSON.stringify(result.rule)}, ${JSON.stringify(result.from)}, ${result.count})`;
    assert.fail(
      result.error
        ? `${call} threw ${result.error}; expected ${JSON.stringify(result.want)}`
        : `${call} returned ${JSON.stringify(result.got)}; expected ${JSON.stringify(result.want)}`,
    );
  }
});
