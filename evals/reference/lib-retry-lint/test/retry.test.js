import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("retries until it succeeds", async () => {
  let n = 0;
  assert.equal(
    await retry(
      () => {
        if (++n < 2) throw new Error("x");
        return "ok";
      },
      { delayMs: 0 },
    ),
    "ok",
  );
});
