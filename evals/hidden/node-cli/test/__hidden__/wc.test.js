import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { count } from "../../src/wc.js";

const cli = fileURLToPath(new URL("../../bin/wc.js", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const tmp = (text) => {
  const f = join(mkdtempSync(join(tmpdir(), "wc-")), "f.txt");
  writeFileSync(f, text, "utf8");
  return f;
};

test("count()", () => {
  assert.deepEqual(count(""), { lines: 0, words: 0, chars: 0 });
  assert.deepEqual(count("one two\nthree\n"), { lines: 2, words: 3, chars: 14 });
  assert.deepEqual(count("  a\t\tb  "), { lines: 0, words: 2, chars: 8 });
  assert.deepEqual(count("héllo 👋"), { lines: 0, words: 2, chars: 7 });
});
test("cli prints lines words chars", () => {
  const r = run(tmp("one two\nthree\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "2 3 14\n");
});
test("cli errors", () => {
  const none = run();
  assert.equal(none.status, 1);
  assert.notEqual(none.stderr.trim(), "");
  const missing = run(join(tmpdir(), "definitely-missing-file-xyz.txt"));
  assert.equal(missing.status, 1);
  assert.notEqual(missing.stderr.trim(), "");
});
