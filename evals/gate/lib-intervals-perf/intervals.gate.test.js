// Gate suite for lib-intervals-perf: run by orch after the repo's own checks pass; the agents cannot run or read it.
// Seeded random inputs against an independent oracle, then the 200,000-interval budget the goal states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const { mergeIntervals, subtractIntervals } = await import(pathToFileURL(resolve("src/intervals.js")).href);

/** mulberry32: the same inputs on every run. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
function intervals(r, n, max) {
  return Array.from({ length: n }, () => {
    const s = int(r, 0, max - 1);
    return [s, int(r, s + 1, Math.min(max, s + 6))];
  });
}

/** Oracle for integer endpoints: mark unit cells [i, i + 1), read back the runs of marked cells. */
const cells = (list, max) => {
  const on = new Array(max).fill(false);
  for (const [s, e] of list) for (let i = s; i < e; i++) on[i] = true;
  return on;
};
function runs(on) {
  const out = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i]) continue;
    let j = i;
    while (j < on.length && on[j]) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

const show = (x) => JSON.stringify(x);

test("mergeIntervals matches the oracle on 3,000 random inputs (smallest first)", () => {
  const r = rng(1);
  for (let i = 0; i < 3000; i++) {
    const max = 4 + (i % 30);
    const input = intervals(r, 1 + Math.floor(i / 300), max);
    const want = runs(cells(input, max));
    const got = mergeIntervals(input);
    assert.deepEqual(got, want, `mergeIntervals(${show(input)}) returned ${show(got)}, expected ${show(want)}`);
  }
});

test("subtractIntervals matches the oracle on 3,000 random inputs (smallest first)", () => {
  const r = rng(2);
  for (let i = 0; i < 3000; i++) {
    const max = 4 + (i % 30);
    const n = Math.floor(i / 300);
    const a = intervals(r, n, max);
    const b = intervals(r, int(r, 0, n + 1), max);
    const A = cells(a, max);
    const B = cells(b, max);
    const want = runs(A.map((x, k) => x && !B[k]));
    const got = subtractIntervals(a, b);
    assert.deepEqual(got, want, `subtractIntervals(${show(a)}, ${show(b)}) returned ${show(got)}, expected ${show(want)}`);
  }
});

const N = 200_000;
/** Generous: the goal asks for one second; a sort-and-sweep solution needs a fraction of that. */
const BUDGET_MS = 3000;

/**
 * Run one call on N random intervals per argument in a worker, killed at the budget: a slow synchronous call would
 * otherwise block this process (and node:test's own timeout) indefinitely. Resolves "ok", "slow" or an error message.
 */
function timed(fn, args) {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    function rng(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    const big = (seed) => { const r = rng(seed); return Array.from({ length: ${N} }, () => { const s = r() * 1e7; return [s, s + 1 + r() * 100]; }); };
    import(workerData.url).then((m) => {
      const input = workerData.seeds.map(big);
      const out = m[workerData.fn](...input);
      for (let i = 1; i < out.length; i++)
        if (!(out[i - 1][1] < out[i][0])) return parentPort.postMessage("results must be sorted, without overlaps or touching intervals");
      parentPort.postMessage("ok");
    }, (e) => parentPort.postMessage(String(e)));`;
  return new Promise((done) => {
    const w = new Worker(code, { eval: true, workerData: { url: pathToFileURL(resolve("src/intervals.js")).href, fn, seeds: args } });
    const timer = setTimeout(() => {
      w.terminate();
      done("slow");
    }, BUDGET_MS + 2000); // + generating the input
    w.on("message", (m) => {
      clearTimeout(timer);
      w.terminate();
      done(m);
    });
    w.on("error", (e) => {
      clearTimeout(timer);
      done(String(e));
    });
  });
}

test(`mergeIntervals handles ${N.toLocaleString("en")} intervals within the time budget`, async () => {
  const r = await timed("mergeIntervals", [3]);
  assert.notEqual(r, "slow", `mergeIntervals on ${N.toLocaleString("en")} intervals is too slow (the goal asks for under a second)`);
  assert.equal(r, "ok");
});

test(`subtractIntervals handles ${N.toLocaleString("en")} intervals on each side within the time budget`, async () => {
  const r = await timed("subtractIntervals", [4, 5]);
  assert.notEqual(r, "slow", `subtractIntervals on ${N.toLocaleString("en")} intervals per side is too slow (the goal asks for under a second)`);
  assert.equal(r, "ok");
});
