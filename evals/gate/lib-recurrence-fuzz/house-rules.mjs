// House rules a CI job enforces and the goal does not state (the same file in each gate suite that uses it: a gate is
// copied on its own). Every finding names the file, the function and what is missing, so a fix round can act on it.
import { readFileSync } from "node:fs";

/** Exported functions without a JSDoc block that has `@param` for each named parameter and `@returns`. */
export function jsdocProblems(file) {
  const src = readFileSync(file, "utf8");
  const problems = [];
  const re = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*=>/g;
  for (const m of src.matchAll(re)) {
    const name = m[1] ?? m[3];
    const params = (m[2] ?? m[4] ?? m[5] ?? "")
      .split(",")
      .map((p) => p.replace(/=[\s\S]*$/, "").trim())
      .filter((p) => /^\w+$/.test(p));
    const before = src.slice(0, m.index).trimEnd();
    const doc = before.endsWith("*/") ? before.slice(before.lastIndexOf("/**")) : null;
    if (!doc || !doc.startsWith("/**")) {
      problems.push(`${file}: ${name} has no JSDoc block (/** ... */ right above it, with @param and @returns)`);
      continue;
    }
    const documented = paramNames(doc);
    for (const p of params) if (!documented.has(p)) problems.push(`${file}: ${name}'s JSDoc has no @param for ${p}`);
    if (!/@returns?\b/.test(doc)) problems.push(`${file}: ${name}'s JSDoc has no @returns`);
  }
  return problems;
}

/**
 * Names documented by the block's `@param` tags. The type may span lines and nest braces
 * (`{{start: string, every: number}}` over several lines); the name follows it, optionally in brackets
 * (`[opts]`, `[opts=1]`) or dotted (`opts.start` documents `opts`). Property names inside the type never count.
 */
export function paramNames(doc) {
  const text = doc.replace(/^[ \t]*\/?\*+\/?/gm, " ");
  const names = new Set();
  for (const m of text.matchAll(/@param\b/g)) {
    let i = m.index + m[0].length;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] === "{") {
      for (let depth = 0; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) break;
      }
      i++;
    }
    const name = /^\s*\[?\s*([A-Za-z_$][\w$]*)/.exec(text.slice(i));
    if (name) names.add(name[1]);
  }
  return names;
}
