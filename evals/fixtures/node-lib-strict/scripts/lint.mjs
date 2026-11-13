// House rules for src/ (see README): JSDoc with @param per parameter and @returns on every exported function,
// named exports only, no console calls, and a test file per module. Exits 1 and lists every problem.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The names after each @param in a JSDoc block, skipping a {type} with nested braces and an optional [name]. */
function paramNames(doc) {
  const names = [];
  for (const m of doc.matchAll(/@param\b/g)) {
    let i = m.index + m[0].length;
    while (/\s/.test(doc[i] ?? "")) i++;
    if (doc[i] === "{") {
      let depth = 0;
      for (; i < doc.length; i++) {
        if (doc[i] === "{") depth++;
        else if (doc[i] === "}" && --depth === 0) break;
      }
      i++;
    }
    while (/[\s*]/.test(doc[i] ?? "")) i++;
    const name = /^\[?([\w$]+)/.exec(doc.slice(i))?.[1];
    if (name) names.push(name);
  }
  return names;
}

const problems = [];
for (const file of readdirSync("src").filter((f) => f.endsWith(".js"))) {
  const path = join("src", file);
  const text = readFileSync(path, "utf8");
  if (/\bconsole\s*\./.test(text)) problems.push(`${path}: no console calls in src/`);
  if (/\bexport\s+default\b/.test(text)) problems.push(`${path}: use named exports, not export default`);
  if (!existsSync(join("test", file.replace(/\.js$/, ".test.js")))) problems.push(`${path}: no test/${file.replace(/\.js$/, ".test.js")}`);
  const fn = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)?\s*export\s+(?:async\s+)?function\s*\*?\s*(\w+)\s*\(([^)]*)\)/g;
  for (const m of text.matchAll(fn)) {
    const [, doc, name, rawParams] = m;
    if (!doc) {
      problems.push(`${path}: ${name}() has no JSDoc block right above it`);
      continue;
    }
    if (!/@returns?\b/.test(doc)) problems.push(`${path}: ${name}() JSDoc has no @returns`);
    // Parameter names: identifiers at the top level; a destructured parameter needs at least one @param.
    let depth = 0;
    let cur = "";
    const params = [];
    for (const ch of rawParams) {
      if ("{[(".includes(ch)) depth++;
      if ("}])".includes(ch)) depth--;
      if (ch === "," && depth === 0) {
        params.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) params.push(cur);
    const documented = paramNames(doc);
    for (const p of params.map((x) => x.trim()).filter(Boolean)) {
      const id = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p)?.[1];
      if (id ? !documented.includes(id) : !documented.length) problems.push(`${path}: ${name}() JSDoc has no @param for "${id ?? p}"`);
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("lint: ok");
