#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { count } from "../src/wc.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: wc.js <file>");
  process.exit(1);
}
let text;
try {
  text = readFileSync(file, "utf8");
} catch (e) {
  console.error(`wc.js: cannot read ${file}: ${e.message}`);
  process.exit(1);
}
const { lines, words, chars } = count(text);
process.stdout.write(`${lines} ${words} ${chars}\n`);
