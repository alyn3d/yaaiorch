// Fake `gh` (GitHub CLI) for tests: answers `gh pr create` without calling GitHub.
// Use it through the launcher next to this file (`gh` on POSIX, `gh.cmd` on Windows) as GH_BIN.
//
//   FAKE_GH_LOG=<file>   append the arguments (one JSON line) and the body read from stdin
//   FAKE_GH_FAIL=1       exit 1 with an error, like gh without a login
//   FAKE_GH_ISSUES=<json>  what `gh issue list` returns: [{number, title, body, labels?}] (labels: only listed
//                        for those labels; without it, for any label)
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const body = args.includes("--body-file") ? readFileSync(0, "utf8") : "";
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, body }) + "\n");
if (process.env.FAKE_GH_FAIL) {
  process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\n");
  process.exit(1);
}
// `gh issue list --label L --json ...`: the issues in FAKE_GH_ISSUES (JSON) that carry the label.
if (args[0] === "issue" && args[1] === "list") {
  const label = args[args.indexOf("--label") + 1];
  const issues = JSON.parse(process.env.FAKE_GH_ISSUES ?? "[]").filter((i) => !i.labels || i.labels.includes(label));
  for (const i of issues) delete i.labels;
  console.log(JSON.stringify(issues));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = args[args.indexOf("--head") + 1];
  console.log(`https://github.com/example/repo/pull/${head.length}`);
  process.exit(0);
}
process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
process.exit(1);
