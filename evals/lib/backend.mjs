// Repo-group cases: the web repo's hidden tests drive its client against the backend the same run built, so a
// contract mismatch between the two repos fails the grade. The runner sets EVAL_BACKEND to that backend repo.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Start the run's backend (`createServer(options)` from its src/server.js) on a free port and call fn(baseUrl). */
export async function withBackend(options, fn) {
  const dir = process.env.EVAL_BACKEND;
  if (!dir) throw new Error("EVAL_BACKEND is not set: grade group cases through evals/run.ts");
  const { createServer } = await import(pathToFileURL(join(dir, "src", "server.js")).href);
  const server = createServer(options);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** The web repo's module `rel` (e.g. "src/api.js"), imported from the repo the test runs in. */
export const web = (rel) => import(pathToFileURL(join(process.cwd(), rel)).href);
