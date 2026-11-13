import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../../src/retry.js";

test("returns the first successful result and passes the attempt number", async () => {
  const seen = [];
  const out = await retry(
    async (n) => {
      seen.push(n);
      if (n < 3) throw new Error(`fail ${n}`);
      return "ok";
    },
    { attempts: 5, delayMs: 0 },
  );
  assert.equal(out, "ok");
  assert.deepEqual(seen, [1, 2, 3]);
});

test("after the last attempt the last error is thrown", async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async (n) => {
        calls++;
        throw new Error(`fail ${n}`);
      },
      { attempts: 3, delayMs: 0 },
    ),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test("defaults: 3 attempts", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      throw new Error("x");
    }, { delayMs: 0 }),
  );
  assert.equal(calls, 3);
});

test("waits delayMs, then multiplies by factor (default 2)", async () => {
  const start = Date.now();
  await assert.rejects(
    retry(
      async () => {
        throw new Error("x");
      },
      { attempts: 3, delayMs: 40 },
    ),
  );
  // 40 + 80 between three attempts.
  assert.ok(Date.now() - start >= 110, `waited ${Date.now() - start} ms`);
  const t2 = Date.now();
  await assert.rejects(
    retry(
      async () => {
        throw new Error("x");
      },
      { attempts: 3, delayMs: 30, factor: 1 },
    ),
  );
  const took = Date.now() - t2;
  assert.ok(took >= 55 && took < 110, `factor 1 waited ${took} ms`);
});

test("shouldRetry(err) false stops at once and rethrows", async () => {
  let calls = 0;
  const fatal = new TypeError("fatal");
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw fatal;
      },
      { attempts: 5, delayMs: 0, shouldRetry: (e) => !(e instanceof TypeError) },
    ),
    (e) => e === fatal,
  );
  assert.equal(calls, 1);
});

test("sync functions and plain values work too", async () => {
  assert.equal(await retry(() => 7, { delayMs: 0 }), 7);
});

test("bad arguments", async () => {
  await assert.rejects(retry("nope"), TypeError);
  for (const attempts of [0, -1, 1.5, NaN, "2"]) await assert.rejects(retry(() => 1, { attempts }), RangeError, String(attempts));
  for (const delayMs of [-1, NaN, "5"]) await assert.rejects(retry(() => 1, { delayMs }), RangeError, String(delayMs));
});
