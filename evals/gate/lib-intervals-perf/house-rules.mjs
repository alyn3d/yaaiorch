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
    for (const p of params) if (!new RegExp(`@param\\b[^\\n]*[\\s}]\\[?${p}\\b`).test(doc)) problems.push(`${file}: ${name}'s JSDoc has no @param for ${p}`);
    if (!/@returns?\b/.test(doc)) problems.push(`${file}: ${name}'s JSDoc has no @returns`);
  }
  return problems;
}
