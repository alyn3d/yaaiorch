// Fake `gh` (GitHub CLI) for tests: answers `gh pr create` without calling GitHub.
// Use it through the launcher next to this file (`gh` on POSIX, `gh.cmd` on Windows) as GH_BIN.
//
//   FAKE_GH_LOG=<file>   append the arguments (one JSON line) and the body read from stdin
//   FAKE_GH_FAIL=1       exit 1 with an error, like gh without a login
//   FAKE_GH_ISSUES=<json>  what `gh issue list` returns: [{number, title, body, labels?}] (labels: only listed
//                        for those labels; without it, for any label)
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

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
  // As gh returns them: labels are objects with a name.
  for (const i of issues) i.labels = (i.labels ?? []).map((name) => ({ name }));
  console.log(JSON.stringify(issues));
  process.exit(0);
}
// `gh pr checks <pr> --json ...`: FAKE_GH_CHECKS="pending,fail,pass" answers call 1, 2, 3... (the last one repeats);
// "none" is gh's "no checks reported". The call count lives in .orchestrator/ (never committed).
if (args[0] === "pr" && args[1] === "checks") {
  const file = ".orchestrator/fake-gh-checks";
  const n = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  writeFileSync(file, String(n + 1));
  const states = (process.env.FAKE_GH_CHECKS ?? "pass").split(",");
  const state = states[Math.min(n, states.length - 1)];
  if (state === "none") {
    process.stderr.write("no checks reported on the 'x' branch\n");
    process.exit(1);
  }
  console.log(JSON.stringify([{ name: "test", bucket: state, link: "https://github.com/example/repo/actions/runs/11/job/22" }]));
  process.exit(state === "pass" ? 0 : state === "pending" ? 8 : 1);
}
// `gh run view <run> --job <job> --log-failed`: one failing line.
if (args[0] === "run" && args[1] === "view") {
  console.log("test\tRun npm test\t##[error] Expected 2, got 3");
  process.exit(0);
}
// `gh issue comment N --body-file -`: logged (args and body) above.
if (args[0] === "issue" && args[1] === "comment") process.exit(0);
if (args[0] === "pr" && args[1] === "create") {
  const head = args[args.indexOf("--head") + 1];
  console.log(`https://github.com/example/repo/pull/${head.length}`);
  process.exit(0);
}
process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
process.exit(1);
