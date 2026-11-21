// Gate suite for lib-intervals-perf: run by orch after the repo's own checks pass; the agents cannot run or read it.
// Seeded random inputs against an independent oracle, then the 200,000-interval budget the goal states. Every call runs
// in a worker (intervals.worker.mjs) with a kill timer: node:test's own timeout cannot stop synchronous code, so a slow
// or endless call would otherwise hang the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const N = 200_000;
/** Generous: the goal asks for one second; a sort-and-sweep solution needs a fraction of that. */
const BUDGET_MS = 3000;

/** Resolves the worker's answer ("ok" or a failure message), or "timeout" once `ms` have passed. */
function inWorker(data, ms) {
  return new Promise((done) => {
    const w = new Worker(new URL("./intervals.worker.mjs", import.meta.url), {
      workerData: { url: pathToFileURL(resolve("src/intervals.js")).href, ...data },
    });
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
      done(`threw ${e}`);
    });
  });
}

for (const which of ["merge", "subtract"]) {
  const fn = `${which}Intervals`;
  test(`${fn} matches the oracle on 3,000 random inputs (smallest first)`, async () => {
    const r = await inWorker({ task: "fuzz", which }, 30_000);
    assert.notEqual(r, "timeout", `${fn} did not return on a small input`);
    assert.equal(r, "ok", r);
  });
  test(`${fn} handles ${N.toLocaleString("en")} intervals per argument within the time budget`, async () => {
    const r = await inWorker({ task: "perf", which, n: N }, BUDGET_MS + 2000); // + generating the input
    assert.notEqual(r, "timeout", `${fn} on ${N.toLocaleString("en")} intervals per argument is too slow (the goal asks for under a second)`);
    assert.equal(r, "ok", r);
  });
}
