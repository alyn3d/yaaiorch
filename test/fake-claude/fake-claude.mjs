// Fake `claude` for tests: answers like `claude -p --output-format json` without calling any model.
// Use it through the launcher next to this file (`claude` on POSIX, `claude.cmd` on Windows) as CLAUDE_BIN.
//
// Behaviour by prompt:
//   architect ("Produce the plan")  -> a fixed plan: fe foundation src/types.ts, be build src/api.ts,
//                                      fe build .\src\ui.ts (backslash on purpose), qa verify
//   verifier ('{"passed": true | false')  -> verdict from FAKE_QA
//   anything else (implementer)     -> writes every "- <path>" listed in the prompt, ends "Status: COMPLETE"
//                                      (the fast path's `dev` agent writes src/direct.txt instead)
//
// Switches (environment):
//   FAKE_LOG=<file>          append one line per call: agent, permission mode, settings file, model, budget cap
//   FAKE_QA=pass|fail|fail-once|needs-new   needs-new passes only if the prompt mentions src/ui.ts and src/api.ts;
//                            fail-once fails the first verdict in the repo, then passes
//   FAKE_TRANSIENT_ONCE=<agent>  that agent's first call fails with "API Error: 529 ... overloaded_error"
//   FAKE_STRAY_FILE=<path>   implementers also write this file, which no task owns
//   FAKE_BE_FILE=<path>     the file the plan gives the be task (default src/api.ts), to test path checks
//   FAKE_QA_NOTE=<text>      a passing QA verdict carries this in "notes"
//   FAKE_CRITIC=approve|reject|reject-once   the plan critic's answer (default approve)
//   FAKE_COST=<usd>          total_cost_usd per call (default 0.05)
//   FAKE_FAIL_AGENT=<name>   that implementer exits 1
//   FAKE_HANG_AGENT=<name>   that implementer never returns
//   FAKE_SLOW=<seconds>      implementers sleep first
//   FAKE_NOWRITE=1           implementers claim COMPLETE but write nothing
//   FAKE_NO_SESSION=1        a call with --resume fails like the real CLI when the session is gone
//   FAKE_REVIEW_REJECT=a,b   these agents reject a diff review (--diff-critic, --review); others approve
//   FAKE_TIDY=bad            the notes tidy call returns no usable notes
// Also answers the notes tidy call and `orch share` (a CLAUDE.md section).
// Every reply carries a new session_id; a call with --resume logs "<agent>: resume=<id> ...".
//   FAKE_BAD_PLAN_ONCE=1     the first plan is not JSON
//   FAKE_LIMIT_ON=3,4        those call numbers return the real usage-limit reply (counted per repo
//                            in .orchestrator/fake-calls, or in FAKE_LIMIT_FILE)
//   FAKE_LIMIT_AFTER=<n>     every call after the n-th returns the usage-limit reply
//   FAKE_USAGE=<5h>,<week>   with --output-format stream-json, print a rate_limit_event first with these
//                            utilizations (fractions, e.g. 0.83,0.24); windows reset FAKE_USAGE_RESET_S (3600) s from now
// Also answers `--version` and `auth status --json` for `orch doctor`, `plugin list --json` and
// `plugin details <id>` for `orch plugins`, and honours --max-budget-usd.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("9.9.9 (fake claude)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
// `plugin list --json` and `plugin details <id>`: two enabled plugins and a disabled one.
if (args[0] === "plugin") {
  const plugins = [
    { id: "caveman@caveman", scope: "user", enabled: true },
    { id: "superpowers@claude-plugins-official", scope: "user", enabled: true },
    { id: "old@market", scope: "user", enabled: false },
  ];
  if (args[1] === "list") console.log(JSON.stringify(plugins));
  else if (args[1] === "details") console.log(`${args[2]}\n\nProjected token cost\n  Always-on:   ~1,234 tok   added to every session`);
  process.exit(0);
}

const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const env = process.env;
const agent = opt("--agent");
const prompt = readFileSync(0, "utf8");
const log = (s) => env.FAKE_LOG && appendFileSync(env.FAKE_LOG, s + "\n");
const cost = Number(env.FAKE_COST ?? 0.05);
const cap = opt("--max-budget-usd");
// Every call gets a new session id (a resumed call is forked, as with --fork-session).
const session = `fake-${agent ?? "x"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const reply = (result, extra = {}) =>
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: cost, session_id: session, ...extra }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agentsFile = opt("--agents");
if (agentsFile) {
  const defs = JSON.parse(readFileSync(agentsFile, "utf8"));
  if (!defs[agent]) {
    reply(`agent ${agent} not in ${agentsFile}`, { is_error: true });
    process.exit(1);
  }
}
log(`call agent=${agent} mode=${opt("--permission-mode")} settings=${opt("--settings")} model=${opt("--model")} cap=${cap}`);
const resume = opt("--resume");
if (resume) {
  log(`${agent}: resume=${resume} fork=${args.includes("--fork-session")} new=${session} files=${prompt.includes("Your files (touch only these):")}`);
  if (prompt.includes("none of your files changed")) log(`${agent}: phantom nudge`);
  // The real CLI prints this on stderr and exits 1 without a result line.
  if (env.FAKE_NO_SESSION) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exit(1);
  }
}

// Subscription usage, as the real CLI streams it before the result line.
if (env.FAKE_USAGE && opt("--output-format") === "stream-json") {
  const [h5, week] = env.FAKE_USAGE.split(",").map(Number);
  const resetsAt = Math.floor(Date.now() / 1000) + Number(env.FAKE_USAGE_RESET_S ?? 3600);
  const win = (utilization) => ({ utilization, resetsAt, status: "allowed" });
  const unifiedWindows = { ...(Number.isFinite(h5) ? { five_hour: win(h5) } : {}), ...(Number.isFinite(week) ? { seven_day: win(week) } : {}) };
  process.stdout.write(
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt, rateLimitType: "five_hour", unifiedWindows } }) + "\n",
  );
}

// Usage limit, exactly as the real CLI reports it.
if (env.FAKE_LIMIT_ON || env.FAKE_LIMIT_AFTER) {
  const f = env.FAKE_LIMIT_FILE ?? ".orchestrator/fake-calls";
  const n = (existsSync(f) ? Number(readFileSync(f, "utf8")) : 0) + 1;
  writeFileSync(f, String(n));
  const listed = (env.FAKE_LIMIT_ON ?? "").split(",").map(Number).includes(n);
  if (listed || (env.FAKE_LIMIT_AFTER && n > Number(env.FAKE_LIMIT_AFTER))) {
    log(`${agent}: usage limit (call ${n})`);
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        total_cost_usd: 0,
        result: "You've hit your 5-hour limit · resets 1:30am (Europe/London)",
      }),
    );
    process.exit(1);
  }
}

// A transient API error on this agent's first call (FAKE_TRANSIENT_ONCE=<agent>), as the CLI reports one.
if (env.FAKE_TRANSIENT_ONCE === agent) {
  const flag = `.orchestrator/fake-transient-${agent}`;
  if (!existsSync(flag)) {
    writeFileSync(flag, "1");
    log(`${agent}: transient error`);
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        total_cost_usd: 0,
        result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    );
    process.exit(1);
  }
}

if (cap !== null && cost > Number(cap)) {
  log(`${agent}: over budget`);
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: cost }));
  process.exit(1);
}

if (prompt.includes("Review this change")) {
  // Diff review (critic against the goal, or a reviewer for bugs): FAKE_REVIEW_REJECT=<agent,agent> reject.
  const lens = prompt.includes("against the goal") ? "goal" : "bugs";
  const reject = (env.FAKE_REVIEW_REJECT ?? "").split(",").includes(agent);
  log(`review: agent=${agent} lens=${lens} patch=${prompt.includes("The change") && prompt.includes("diff --git")} ${reject ? "rejected" : "approved"}`);
  reply(reject ? `{"approved": false, "issues": ["${agent} found a bug in src/api.ts"]}` : '{"approved": true, "issues": []}');
} else if (prompt.includes("Tidy these lessons")) {
  // notes.md past its size limit: FAKE_TIDY=bad returns something unusable.
  log(`tidy: called sawLessons=${prompt.includes("FAKE LESSON")}`);
  reply(env.FAKE_TIDY === "bad" ? "no idea" : JSON.stringify({ notes: "- FAKE TIDIED: one merged lesson" }));
} else if (prompt.includes("section of this repository's CLAUDE.md")) {
  log(`share: called brief=${prompt.includes("FAKE BRIEF")} earlier=${prompt.includes("earlier version of this section")}`);
  reply(JSON.stringify({ section: "FAKE SECTION: build with npm test; src/ holds the code." }));
} else if (prompt.includes("Study this repository")) {
  // orch learn: a read-only pass that returns the project brief.
  log(`learn: called old=${prompt.includes("The current project brief")}`);
  reply(JSON.stringify({ brief: "FAKE BRIEF learned: node project, src/ holds the code, tests in test/." }));
} else if (prompt.includes("Produce the plan")) {
  const flag = ".orchestrator/fake-bad-plan-done";
  if (env.FAKE_BAD_PLAN_ONCE && !existsSync(flag)) {
    writeFileSync(flag, "1");
    log("architect: bad plan");
    reply("Here you go: { not json");
  } else {
    if (prompt.includes("previous reply was rejected")) log("architect: got rejection reason");
    if (prompt.includes("Do not repeat the previous plan")) log("architect: got stuck note");
    if (prompt.includes("A reviewer rejected your plan")) log("architect: got critic issues");
    const human = /The person reviewing your plan rejected it:\n(.*)/.exec(prompt);
    if (human) log(`architect: got human rejection: ${human[1]}`);
    log(`architect: notes=${prompt.includes("Notes from earlier goals") && prompt.includes("FAKE LESSON") ? "seen" : "none"}`);
    // Context between rounds and the project brief, as the architect sees them.
    if (prompt.includes("may be out of date")) log("architect: brief stale");
    log(
      `architect: previousRound=${/What round \d+ did/.test(prompt) && prompt.includes("Plan: fake plan")} brief=${prompt.includes("FAKE BRIEF") ? "seen" : prompt.includes("No project brief exists yet") ? "asked" : "none"}`,
    );
    const plan = {
      summary: "fake plan",
      tasks: [
        { agent: "fe", phase: "foundation", task: "types", files: ["src/types.ts"] },
        { agent: "be", phase: "build", task: "api", files: [env.FAKE_BE_FILE ?? "src/api.ts"] },
        { agent: "fe", phase: "build", task: "ui", files: [".\\src\\ui.ts"] },
        { agent: "qa", phase: "verify", task: "check it" },
      ],
      ...(prompt.includes("No project brief exists yet") ? { brief: "FAKE BRIEF: a fake repo with src/ and no checks." } : {}),
    };
    reply("```json\n" + JSON.stringify(plan) + "\n```");
  }
} else if (prompt.includes('{"approved": true | false')) {
  // Plan critic: FAKE_CRITIC=approve (default) | reject | reject-once.
  const mode = env.FAKE_CRITIC ?? "approve";
  const flag = ".orchestrator/fake-critic-done";
  const reject = mode === "reject" || (mode === "reject-once" && !existsSync(flag));
  if (mode === "reject-once") writeFileSync(flag, "1");
  log(`critic: ${reject ? "rejected" : "approved"} sawPlan=${prompt.includes('"fake plan"')}`);
  reply(reject ? '{"approved": false, "issues": ["the plan forgets the tests"]}' : '{"approved": true, "issues": []}');
} else if (prompt.includes('{"passed": true | false')) {
  const mode = env.FAKE_QA ?? "pass";
  const sawNew = /ui\.ts/.test(prompt) && /api\.ts/.test(prompt);
  if (prompt.includes("## Project brief")) log("qa: got brief");
  if (prompt.includes("outside every task's file list")) log("qa: told about files outside the plan");
  log(`qa: sawNewFiles=${sawNew}`);
  const failOnce = mode === "fail-once" && !existsSync(".orchestrator/fake-qa-failed");
  if (failOnce) writeFileSync(".orchestrator/fake-qa-failed", "1");
  if (mode === "fail" || failOnce) reply('{"passed": false, "failures": ["fake failure"]}');
  else if (mode === "needs-new" && !sawNew) reply('{"passed": false, "failures": ["QA did not see new files"]}');
  else reply(JSON.stringify({ passed: true, failures: [], ...(env.FAKE_QA_NOTE ? { notes: [env.FAKE_QA_NOTE] } : {}) }));
} else {
  if (env.FAKE_FAIL_AGENT === agent) {
    log(`${agent}: crashing`);
    process.exit(1);
  }
  if (env.FAKE_HANG_AGENT === agent) {
    log(`${agent}: hanging`);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (env.FAKE_SLOW) await sleep(Number(env.FAKE_SLOW) * 1000);
  if (prompt.includes("## Project brief")) log(`${agent}: got brief`);
  // The fast path's generalist gets no file list; it writes one file of its own.
  // Only the task's own file list counts, not bullet points in the brief or the notes above it.
  const own = prompt.split("Your files (touch only these):")[1]?.split("\n## ")[0] ?? "";
  const files = agent === "dev" ? ["src/direct.txt"] : [...own.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());
  if (!env.FAKE_NOWRITE)
    for (const f of files) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `// ${agent} ${Date.now()} ${Math.random()}\n`);
    }
  if (env.FAKE_STRAY_FILE && agent === "be") {
    mkdirSync(dirname(env.FAKE_STRAY_FILE), { recursive: true });
    writeFileSync(env.FAKE_STRAY_FILE, "not in any task's list\n");
  }
  log(`${agent}: wrote ${env.FAKE_NOWRITE ? "nothing" : files.join(",")}`);
  reply("done\nStatus: COMPLETE");
}
