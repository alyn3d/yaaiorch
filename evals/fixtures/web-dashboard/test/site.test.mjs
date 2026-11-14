import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileFor } from "../server.mjs";

const pub = join(import.meta.dirname, "..", "public");

test("routes map to files", () => {
  assert.equal(fileFor("/"), "index.html");
  assert.equal(fileFor("/dashboard"), "dashboard.html");
  assert.equal(fileFor("/styles.css?v=2"), "styles.css");
});

test("every page has a title, a viewport meta and the shared stylesheet", () => {
  for (const f of readdirSync(pub).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(join(pub, f), "utf8");
    assert.match(html, /<title>[^<]+<\/title>/, f);
    assert.match(html, /name="viewport"/, f);
    assert.match(html, /href="\/styles\.css"/, f);
  }
});
