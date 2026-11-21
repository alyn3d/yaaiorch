// Runs one gate task against the repo's src/intervals.js and posts "ok" or a failure message. Run in a worker so the
// gate can kill a call that is too slow or never returns.
import { parentPort, workerData } from "node:worker_threads";

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
function cells(list, max) {
  const on = new Array(max).fill(false);
  for (const [s, e] of list) for (let i = s; i < e; i++) on[i] = true;
  return on;
}
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
const same = (a, b) => show(a) === show(b);

/** Random inputs, smallest first; the first mismatch is reported. */
function fuzz(m, which) {
  const r = rng(which === "merge" ? 1 : 2);
  for (let i = 0; i < 3000; i++) {
    const max = 4 + (i % 30);
    const n = which === "merge" ? 1 + Math.floor(i / 300) : Math.floor(i / 300);
    const a = intervals(r, n, max);
    if (which === "merge") {
      const want = runs(cells(a, max));
      const got = m.mergeIntervals(JSON.parse(show(a)));
      if (!same(got, want)) return `mergeIntervals(${show(a)}) returned ${show(got)}, expected ${show(want)}`;
    } else {
      const b = intervals(r, int(r, 0, n + 1), max);
      const B = cells(b, max);
      const want = runs(cells(a, max).map((x, k) => x && !B[k]));
      const got = m.subtractIntervals(JSON.parse(show(a)), JSON.parse(show(b)));
      if (!same(got, want)) return `subtractIntervals(${show(a)}, ${show(b)}) returned ${show(got)}, expected ${show(want)}`;
    }
  }
  return "ok";
}

/** One call on 200,000 random intervals per argument; the result must still be sorted and disjoint. */
function perf(m, which, n) {
  const big = (seed) => {
    const r = rng(seed);
    return Array.from({ length: n }, () => {
      const s = r() * 1e7;
      return [s, s + 1 + r() * 100];
    });
  };
  const out = which === "merge" ? m.mergeIntervals(big(3)) : m.subtractIntervals(big(4), big(5));
  for (let i = 1; i < out.length; i++) if (!(out[i - 1][1] < out[i][0])) return "results must be sorted, without overlaps or touching intervals";
  return "ok";
}

/**
 * House rule: an error message starts with the function's name and a colon, then names the bad argument or element.
 * Returns every call that breaks it.
 */
function errorRules(m) {
  const cases = [
    ["mergeIntervals", ['"x"'], TypeError, "mergeIntervals: list"],
    ["mergeIntervals", ["[[1, 2], [3, 1]]"], RangeError, "mergeIntervals: list[1]"],
    ["subtractIntervals", ["[[0, 1]]", "5"], TypeError, "subtractIntervals: b"],
    ["subtractIntervals", ["[[0, 1], [2, 1]]", "[]"], RangeError, "subtractIntervals: a[1]"],
    ["subtractIntervals", ["[]", "[[5, 2]]"], RangeError, "subtractIntervals: b[0]"],
  ];
  const problems = [];
  for (const [fn, args, type, prefix] of cases) {
    const call = `${fn}(${args.join(", ")})`;
    try {
      m[fn](...args.map((a) => JSON.parse(a)));
      problems.push(`${call} did not throw`);
    } catch (e) {
      const head = new RegExp(`^${prefix.replace(/[[\]]/g, "\\$&")}(?![\\w[])`);
      if (!(e instanceof type)) problems.push(`${call} threw ${e?.name}; expected a ${type.name}`);
      else if (!head.test(e.message)) problems.push(`${call} threw "${e.message}"; the message must start with "${prefix}"`);
    }
  }
  return problems.length ? `error messages must start with the function name and a colon, then name the bad argument or element:\n- ${problems.join("\n- ")}` : "ok";
}

import(workerData.url).then(
  (m) => {
    try {
      const { task } = workerData;
      parentPort.postMessage(task === "rules" ? errorRules(m) : task === "fuzz" ? fuzz(m, workerData.which) : perf(m, workerData.which, workerData.n));
    } catch (e) {
      parentPort.postMessage(`threw ${e}`);
    }
  },
  (e) => parentPort.postMessage(`could not load src/intervals.js: ${e}`),
);
