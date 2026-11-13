// Fake `gh` (GitHub CLI) for tests: answers `gh pr create` without calling GitHub.
// Use it through the launcher next to this file (`gh` on POSIX, `gh.cmd` on Windows) as GH_BIN.
//
//   FAKE_GH_LOG=<file>   append the arguments (one JSON line) and the body read from stdin
//   FAKE_GH_FAIL=1       exit 1 with an error, like gh without a login
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const body = args.includes("--body-file") ? readFileSync(0, "utf8") : "";
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, body }) + "\n");
if (process.env.FAKE_GH_FAIL) {
  process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\n");
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = args[args.indexOf("--head") + 1];
  console.log(`https://github.com/example/repo/pull/${head.length}`);
  process.exit(0);
}
process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
process.exit(1);
