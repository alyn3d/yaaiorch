import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../src/server.js";

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, body) => fetch(`${base}/products`, { method: "POST", body: JSON.stringify(body) });

test("the API rejects a price that is not a whole number of cents", () =>
  withServer({}, async (base) => {
    for (const priceCents of [12.5, 0.1, -1, -0.5, "1250", null, Infinity]) {
      const res = await post(base, { name: "Mug", priceCents });
      assert.equal(res.status, 400, `priceCents ${String(priceCents)}`);
      assert.equal((await res.json()).error.code, "validation_failed");
    }
    const list = await (await fetch(`${base}/products`)).json();
    assert.equal(list.items.length, 0, "nothing was stored");
  }));

test("whole cents, including 0, are still accepted", () =>
  withServer({}, async (base) => {
    for (const priceCents of [0, 1, 1250, 1_000_000]) assert.equal((await post(base, { name: "Mug", priceCents })).status, 201, String(priceCents));
  }));
