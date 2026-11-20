// Loads orch-ui's tsx ESM API from the tests (which sit outside orch-ui, where tsx is installed).
// require.resolve picks tsx's CommonJS entry; importing that breaks on Node 22, so take the "import" entry from tsx's
// exports map instead.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function tsxApi(root) {
  const pkgPath = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/package.json");
  const entry = JSON.parse(readFileSync(pkgPath, "utf8")).exports["./esm/api"].import.default;
  return import(pathToFileURL(join(dirname(pkgPath), entry)).href);
}
