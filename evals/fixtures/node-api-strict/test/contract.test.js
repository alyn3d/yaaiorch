// The API contract: every route in src/routes.js is served, documented in docs/API.md, and has a test named
// "<METHOD> <path> ..." in test/. Part of `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ROUTES } from "../src/routes.js";
import { createServer } from "../src/server.js";

const docs = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");
const testText = readdirSync(new URL(".", import.meta.url))
  .filter((f) => f.endsWith(".test.js") && f !== "contract.test.js")
  .map((f) => readFileSync(new URL(f, import.meta.url), "utf8"))
  .join("\n");

for (const r of ROUTES) {
  const name = `${r.method} ${r.path}`;
  test(`contract: ${name} is listed in docs/API.md`, () => {
    const row = new RegExp(`^\\|\\s*${r.method}\\s*\\|\\s*${r.path.replace(/[/:]/g, "\\$&")}\\s*\\|`, "m");
    assert.match(docs, row, `docs/API.md needs a table row "| ${r.method} | ${r.path} | ... |"`);
  });
  test(`contract: ${name} has a test named after it`, () => {
    assert.ok(testText.includes(`"${name}`) || testText.includes(`'${name}`) || testText.includes(`\`${name}`), `a test in test/ must be named "${name} ..."`);
  });
  test(`contract: ${name} is served`, async () => {
    const server = createServer({ todos: [{ id: 1, title: "a", done: false }] });
    await new Promise((ok) => server.listen(0, ok));
    try {
      const url = `http://127.0.0.1:${server.address().port}${r.path.replace(/:\w+/g, "1")}`;
      const res = await fetch(url, { method: r.method, headers: { "content-type": "application/json" }, ...(r.method === "GET" ? {} : { body: "{}" }) });
      assert.notEqual(res.status, 404, `${name} answered 404`);
      await res.arrayBuffer();
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
}
