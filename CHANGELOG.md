# Changelog

All notable changes to YAAIORCH. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) (0.x: anything may change).

## [Unreleased]

## [0.5.0] - 2026-11-13

From backlog to merged pull request: goals come in from GitHub issues (or a backlog file), run in priority order,
comment on their issue, open a pull request and see its CI through, fixing it when it fails. Safer unattended runs
(protected paths, a secret scan before every commit), a redesigned app, and a desktop app that brings its own
Node.js. Tested with the fake claude and a fake gh; the issue and CI flows have not run against real GitHub yet.

### Changed
- **The desktop app brings its own Node.js**: the installers include the official Node.js 22 build for their
  platform (checked against its SHA-256 at build time), so Node.js no longer has to be installed or on PATH.
  `YAAIORCH_NODE` points the app at another one. The CLI bundle still needs Node.js 20+.
- **A new look for the app**: a left sidebar with the repos and their status (Overview, Open repo, New project,
  and limits, parallel runs and notifications at the bottom), and a cleaner repo page: a goal composer with the run
  settings folded into one panel, the Big brief in its own card, and from 1180px the run and live output beside
  the queue. One dark theme built on design tokens, pill badges, switches, status stripes on tasks, a modal for New
  project, and empty states that say what to do next.

### Added
- **orch sees its pull requests through CI**: with `--pr`, orch waits for the pull request's checks; when one
  fails, it runs a fix goal on the PR branch with the failing job's log (up to `--ci-fixes N`, default 2; it may
  not touch the workflows), pushes and waits again. The run panel and the issue comment show the CI result.
  `--no-ci-watch` to skip it. New `ci` event.
- **Issues hear back, and priorities count**: a goal from a GitHub issue comments on it when it starts, is done
  (with the pull request), fails for good (with what was still wrong) or is blocked; `--no-issue-comments` to
  stay quiet. Labels `p1`-`p9` or `priority: high|low` (and `(p1)` in a backlog item) decide which runnable goal
  goes first; the queue shows them.
- **Protected paths**: the config's `protect` list (default `.github/workflows/`; `--protect`) is off limits to
  agents: a plan that lists such a file goes back to the architect, and a change there anyway is reverted and
  fails the round. New `protected` event.
- **Secret scan**: before every commit the changes are checked for known key and token formats, private keys and
  `.env` files. A finding blocks the commit (so nothing is pushed) and fails the round; the value is never
  printed. `--no-secret-scan` / `"secretScan": false`. New `secrets` event.
- **Goals from your backlog**: `orch intake --github LABEL` queues open GitHub issues with that label (via `gh`),
  `--backlog BACKLOG.md` the unchecked items of a backlog file, each once and without changing your files.
  `orch loop --intake github:LABEL` keeps pulling new issues in when the queue runs dry, and with `--pr` the pull
  request closes the issue. In the UI: **Issues label**, **Import issues**, and **Loop (watch)** with the label.
  Issue text becomes agent instructions, so use a label only people you trust can set. New `intake` event.
- Eval cases built to need a fix round, `api-patch-contract` and `lib-retry-lint`, on two new fixtures whose house
  rules only the repo's checks enforce; they measure session resume, the critics and escalation.
- Unit tests for the UI's run view (`reduce.ts`) and the desktop app's project-name check.

### Fixed
- The pull request link in the run panel did nothing in the desktop app; it now opens the system browser.
- The UI's daily budget capped each goal of a queue, so the goal it ran out in failed (and blocked the goals that
  need it). A queue now gets what is left of the day as its overall budget: that goal stays pending and the
  queue stops, like with **Budget $**.

## [0.4.0] - 2026-11-13

From one goal at a time to whole projects: give orch a big brief (or a spec for a new project) and it splits it
into goals that build on each other, runs them unattended with a budget, retries and progress, and opens one
pull request for the lot. Also better results per round (session resume, diff critic, review lens, tidier
memory), a plan approval gate, notifications, and `claude` started without a shell on Windows. Tested end to
end with the fake claude and in a real smoke run; the new features are not measured by the evals yet.

### Added
- **Budget and progress for a whole queue**: **Budget $** in the queue section (and **Total $** for a new project)
  caps all the goals a loop runs together (`--max-cost-total`). The latest brief's progress shows above the
  queue (a bar, goals done, failed and blocked, what it cost, a rough time left) and as "7/23" in the overview,
  updated live: the loop now records each goal's cost and time in the queue and emits `queue_changed`.
- **Goals that build on each other**: a split brief says which earlier goals each goal needs. A failed goal is
  tried again one power tier higher (`--retries N`, default 1); if it still fails, the goals that need it are
  marked **blocked** and skipped, independent ones go on, and you get a notification. **Retry** (`orch retry ID`)
  puts it back with what it blocked. New `retry` and `blocked` events; the queue shows each goal's dependencies.
- **Big briefs**: `orch split "<brief>"` (or `--brief-file`, `--start`) and a **Big brief** box per repo: the
  architect splits a long brief into goals in build order, you edit the list and queue it, or queue it and start
  the loop. The brief is kept in `.orchestrator/spec.md` and read by every goal's architect, and when the queue
  runs dry a coverage check queues what is still missing (at most twice; `--no-coverage`). `orch new` uses the
  same splitter, takes `--start`, and queues up to 30 goals. New `split_proposal` and `coverage` events.
- **+ New project** in the UI: pick a parent folder and a name, paste the spec, optionally a setup command, a
  budget and **Start building right away**; the new project opens in its own tab.
- **New projects**: `orch new DIR "<spec>"` (or `--spec-file`) creates a git repo with `SPEC.md`, uses the spec as
  the project brief, and queues the architect's goals (scaffold first) with suggested checks; run `orch loop`
  there to build it.
- **Dependency setup**: `"setup": "npm install"` in the config (or `orch new --setup`) is run by orch before the
  checks whenever a manifest or lock file changed; the folders it creates stay out of git. Agents still never
  install anything.
- Eval case `greenfield-inventory`: an empty repo, a scaffold goal and a feature goal.
- **Notifications** (**Notify** in the header): a desktop notification when a goal passes or fails, a plan
  waits for approval, or a run waits for the usage limit or your cap, while the window is not in front. The
  desktop app uses the Tauri notification plugin, browser mode the browser's notifications.
- **Plan approval** (`--approve-plan`, **Approve plans** in the run settings): after planning, the run waits for
  you to build the plan, edit it, or send it back to the architect with a reason. The run panel shows the plan
  with those three buttons; in a terminal, `orch approve [--reject "why"] [--plan-stdin]`. New `approval_wait`
  and `approval` events.
- **A branch and a pull request per goal** (`--branch`, `--pr`; **Branch per goal** and **Open pull request** in
  the run settings): each goal runs on its own `orch/<id>-<slug>` branch and orch switches back afterwards, so
  your branch never changes. With `--pr`, a passed goal is pushed and a pull request opened with `gh`; a
  missing remote or `gh` is reported without failing the goal. New `goal_branch` and `pr` events.
- **Diff critic** (`--diff-critic`, **Diff critic** in the run settings): the critic also reviews each round's
  change against the goal, next to QA; a rejection fails the round.
- **Review lens** (`--review`, **Review lens**): a read-only reviewer checks each round's change for bugs and
  security problems, the new built-in `reviewer` or your own agents (`--reviewers security-reviewer,...`).
  Both diff reviews are skipped when a check already failed, are off by default, and count toward the budget.
  New `review` event; eval configs `+diffcritic` and `+review`.
- **Tidy notes**: when `.orchestrator/notes.md` passes 5,000 characters, one cheap call merges duplicate
  lessons and drops ones that no longer apply, instead of only cutting the oldest. New `notes_tidy` event.
- **Share what was learned**: `orch share` (**Share to CLAUDE.md**) writes the brief and lasting lessons as a
  section of the repo's `CLAUDE.md` and commits it on an `orchestrator/claude-md-*` branch for you to review
  and merge; your working tree is untouched. Sharing again replaces the section. New `share_start` /
  `share_end` events.
- **Session resume for fix rounds**: when a round fails, the next round's implementer tasks continue the same
  agent's session from that round (on the same files) instead of starting cold, so they keep what they read
  and did. After a stuck round they start fresh; if a session is gone they start cold. A phantom completion's
  retry is told, in the same session, which files did not change. The run panel marks resumed tasks.
  `--no-resume` or `"resume": false` turns it off; eval config suffix `+noresume`. Not measured yet.

### Changed
- Checks are read again every round (after the build), so checks from a package.json the agents just wrote run
  in the same round.
- Development: ESLint, Prettier, rustfmt and clippy run in CI (`npm run lint`, `npm run format:check`);
  the code was formatted once (that commit is in `.git-blame-ignore-revs`).
- Windows: `claude` is started without cmd.exe. orch finds it on PATH once: the native `claude.exe` runs
  directly, and npm's `claude.cmd` is unwrapped to node and the script it starts. This removes cmd.exe's
  quoting rules from every agent call (a `CLAUDE_BIN` path with `&`, `%` or `^` works) and Node's `DEP0190`
  warning. The current directory is no longer searched, so a target repo cannot plant a `claude.cmd`.
  A shim orch cannot read still goes through cmd.exe, and `orch doctor` says so.

### Fixed
- A goal cut short by the usage limit started over after the reset, redoing (and paying for) the work it had
  already committed. The next attempt now brings that work back from where it was parked and tells the
  architect, which plans only what remains. New `resumed` event.
- A goal stopped because the queue's budget (`--max-cost-total`, **Budget $**) ran out was marked failed, which
  now also blocked every goal that needs it. It stays pending with a note instead, the loop stops, and a run
  with more budget carries on. A goal over its own `--max-cost` still fails.
- `--branch` with a brief: each goal branched from the starting branch, so later goals never saw the earlier
  goals' work. A brief's goals now share one branch, `orch/brief-<id>`; a failed goal is parked instead of
  staying under the next ones, and `--pr` opens one pull request for the brief that grows with each goal.

## [0.3.0] - 2026-11-13

Reliability and memory: the orchestrator learns a repo (project brief, notes between goals, `orch learn`),
plans get an optional critic, fix rounds build on the previous round, and running it unattended is safer
(a run lock per repo, safe queue edits, plan path checks, retries, a loop budget, a protected browser
server). Relicensed under GPL-3.0-only.

### Added
- **Retry of transient errors**: an agent call that fails with an API overload, a 5xx or 429 API error or a
  dropped connection is retried once after 15 s. The usage limit, the budget and timeouts are never retried.
- **Files outside the plan**: files changed outside every task's file list are reported to QA (and shown in
  the run panel); with `--strict-files` (config `strictFiles`) they fail the round. New `unowned` event.
- **Loop budget**: `--max-cost-total USD` (config `maxCostTotal`) caps a whole `loop` run; each goal gets at
  most what is left and the loop stops before the next goal when it is used up (`loop_stop`, reason `budget`).
- Tests: scenarios for phantom completion, a failed foundation task, retries, files outside the plan and the
  loop budget, and unit tests for orch.ts's parsing and validation helpers (`test/unit.test.mjs`).
- Evals: **series cases** (`tickets-series`, `api-series`): three goals in a row on one repo, graded at the
  end, to measure the project brief and notes; runner configs `+nomem` (`--no-brief --no-notes`) and
  `+critic`, combinable with a tier and `+fast`.
- **Stop after this goal** for queue loops: `orch stop-after` or a button in the UI while a queue runs;
  the current goal finishes and the rest stay pending.
- **Project brief**: the architect writes `.orchestrator/brief.md` (stack, layout, conventions,
  commands) on the first run; later rounds, later goals and the fast path's agent reuse it instead of
  re-reading the repo. `--no-brief` or `"brief": false` turns it off.
- **Context between rounds**: a fix round's architect sees what the previous round planned, how each
  task ended and the diff since the checkpoint, not only the failure messages.
- **Per-task escalation**: a stuck round where some tasks failed and others completed moves only the
  failing tasks' agents up a tier (shown in the run panel); otherwise the whole round moves up as before.
- **Memory between goals**: `.orchestrator/notes.md` collects QA's notes, the first failures of goals
  that needed several rounds and what failed goals left unresolved; the architect reads it before
  planning. `--no-notes` or `"notes": false` turns it off.
- **Plan critic** (off by default): `--critic`, `"critic": true` or **Plan critic** in the run settings.
  A built-in read-only `critic` agent reviews each plan before building; a rejection goes back to the
  architect once. The run panel shows its verdict. New `critic` event.

- **Learn repo**: `orch learn` (and a **Learn repo** button) studies the repo in one read-only call and
  writes the project brief up front. Implementers and QA now get the brief and recent notes too, not only
  the architect. The brief records the commit it describes; after 20 or more changed files the next goal's
  architect checks and corrects it. New `learn_start` / `learn_end` events; the cost counts toward the
  daily budget.

These are not measured by the evals yet (the current cases pass in round 1).

### Changed
- **License: GPL-3.0-only** (was MIT). Versions up to and including 0.2.0 remain available under MIT.

### Fixed
- Two orch processes could run in the same repo (for example a CLI `loop` next to the UI) and overwrite
  each other's work. A run lock (`.orchestrator/run.lock`) now allows one at a time; a lock left by a
  crashed or killed process is taken over automatically.
- Goals added while a loop was running could be lost (both read and rewrote `queue.json`). Queue edits now
  happen under a short lock, and the browser server adds goals through `orch add`.
- State files (`queue.json`, `last-run.json`, `brief.md`, `notes.md`) are written atomically, and a damaged
  `queue.json` is reported instead of being replaced with an empty queue.
- Plans are checked as untrusted input: file paths outside the repo (absolute, `..`, drive or UNC paths, or
  through a symlink or junction), inside `.git/` or `.orchestrator/`, and oversized plans are rejected with
  the task and file named.

### Security
- The browser-mode server could be driven by any web page you visited (it accepted every request on
  `localhost:4317`), for example to start runs on your Claude account. It now refuses requests whose
  `Host` or `Origin` is not local (this also stops DNS rebinding) and requires a per-process session
  token on every `/api` call; the UI fetches it automatically. The desktop app was not affected.

## [0.2.0] - 2026-11-12

Several repos at once, shared limits across them, control over cost (daily budget, usage caps, plugins
for agents) and safer git and budget handling.

### Added
- Model selection per role (architect, implementers, heavy tasks, QA, fast-path agent) and per agent:
  `--model architect=opus,impl=haiku,be=<model id>`, `"models"` in `.orchestrator/config.json`, and a
  **Models** section in the UI. Aliases step up with the tier when a round gets stuck; full IDs stay.
- **When the usage limit is hit** setting: `--on-limit wait|stop`, `"onLimit"` in config, and a UI
  choice. `wait` (default) now applies to `orch run` too: the interrupted work is set aside and the
  goal is retried after the reset.
- UI: Fast path checkbox; the run panel shows the models used per round.
- App icon for the desktop app and the browser UI.
- Eval runner: `--orch-model` passes a model spec to every orch run.
- **Several repos at once**: one tab per repo in the browser UI and the desktop app, each with its own
  goal, queue, settings and log and a status dot; a global **Parallel** limit (default 2) with a start
  queue; open repos are remembered (`~/.yaaiorch/ui.json`, `<app config>/repos.json`).
- **Shared usage limit** across repos: when one repo hits it, new runs in every repo wait for the
  reset, with one banner and a **Try now** button.
- **Daily budget** across repos (**Daily $**): counts every agent call's cost, caps each run's
  `--max-cost` to what is left, holds new runs and stops a queue before its next goal when used up;
  the day's total survives restarts. A waiting repo shows why it waits.
- **Overview** tab (two or more repos): one row per repo with phase, goal, round, tasks, cost and
  queue, and Open / Stop buttons.
- **Usage caps in percent**: the header shows the Claude subscription's 5-hour and weekly usage, and
  **Limits** has "Pause at 5h %" and "Pause at week %" (CLI: `--usage-cap 5h=80,week=90`, config
  `usageCap`). At a cap, new runs wait and running goals pause before their next agent call until the
  window resets (or stop, with `--on-limit stop`). New `usage` event.
- **Plugins for agents**: agents load your Claude Code plugins and hooks, which add context to every
  call. A **Plugins** section per repo lists them with the tokens each adds and has a switch per plugin,
  one for all and one for hooks. CLI: `orch plugins [--details]`, `--plugins off`,
  `--disable-plugins ID,ID`, `--no-hooks`, config `plugins`. Claude Code itself is unchanged.

### Changed
- Agents run with `--output-format stream-json --verbose` (to read the usage windows); the final result
  is parsed as before.
- `orch run` waits for the usage-limit reset by default instead of exiting with code 3; use
  `--on-limit stop` for the old behaviour (the eval runner does).

### Fixed
- Round commits failed when the target repo's `.gitignore` lists `.orchestrator/`: the work stayed
  staged, the goal still passed, and the next run refused the dirty tree.
- A passed goal no longer deletes its checkpoint when the final commit fails (for example a rejecting
  pre-commit hook): the checkpoint and the rollback offer stay, and the run says what is uncommitted.
  `orch rollback` and parking failed work skip commit hooks, since those commits only land on
  `orchestrator/*` side branches, so recovery cannot be blocked.
- `--max-cost` could be overspent by parallel agents: each build agent got the whole remaining budget.
  Now every call reserves its share before it starts (parallel build tasks split what is left equally)
  and releases it when it ends, also on failure or timeout.
- A repo paused at your usage cap no longer says "waiting for the usage limit" in its tab and the
  overview: it says "paused at your usage cap".

## [0.1.0] - 2026-11-12

First public release.

### Orchestrator (`orch.ts`)
- Loop: architect plan → foundation tasks in order → build tasks in parallel → the repo's checks →
  QA verdicts, repeated with the failures until QA passes or max rounds is reached.
- Commands: `run`, `add`, `loop`, `status`, `agents`, `doctor`, `rollback`, `prune`.
- Power tiers `economy`, `balanced`, `heavy`, `max` mapping roles to models.
- Built-in `architect`, `fe`, `be` and `qa` agents; user and project agents are discovered and
  override them. Reply formats are appended to every prompt.
- Plan validation (agents, phases, owned files, normalized paths) with one retry on a rejected plan.
- Phantom-completion check: a task that claims success without changing its files is re-run.
- The orchestrator runs the repo's checks itself (`.orchestrator/config.json` or `package.json`
  scripts); a failed check fails the round regardless of QA.
- Git: refuses a dirty tree, checkpoint branch per goal, a commit per round, checkpoint deleted on
  pass, failed loop goals parked on `orchestrator/failed-*`; `rollback` keeps discarded work on
  `orchestrator/discarded-*`; `prune` removes old branches.
- Limits: per-agent timeout that kills the process tree, budget per goal (`--max-cost`), stuck
  detection that moves up a tier and then stops.
- Least privilege: architect and QA run read-only (`default` permission mode, edit tools denied);
  implementers get `acceptEdits` plus an allow-list for the check commands.
- Usage limit: detected with its reset time; the goal stops with exit code 3, `loop` requeues it and
  waits for the reset.
- Structured `@@ORCH@@` event stream for UIs, including costs per task, round and goal.

### UI (`orch-ui/`)
- React UI with live task cards, check badges, costs, power tier per round and stuck notes.
- Browser mode (`server.ts`, HTTP + SSE) and a Tauri v2 desktop app with a repo picker.
- Doctor banner, rollback offer with confirmation, budget field, Stop with stopped-run detection.

### Evals (`evals/`)
- 10 cases over three dependency-free fixtures (Node library, Node API, Python package), graded by
  hidden tests the agents never see, each with a reference solution.
- Runner with per-tier and per-case tables, false-pass count, `--reference` self-check,
  `--resume` and `--wait-on-limit`.

### Testing
- Fake `claude` (`test/fake-claude/`) and 19 end-to-end scenario tests (`npm test` in `orch-ui`),
  run in CI on Linux and Windows, plus the desktop backend's spawn test against the fake.
- Eval suite grown to 21 cases on five fixtures (Node library, Node API, Node shop, layered Node
  ticket service, Python, Go), including 4 long-horizon cases.
- Single-agent control group in the eval runner (`--single <models>`), and `+fast` tier labels.

### Experimental
- `--fast`: round 1 is one generalist `dev` agent judged by the repo's checks; the full loop runs
  only if that fails. Not yet measured with real models.

### Fixed
- Windows: a `CLAUDE_BIN` path containing spaces (for example under `C:\Program Files`) broke every
  agent call and `orch doctor`, because cmd.exe received it unquoted.

### Known limitations
- Installers are not code-signed: Windows SmartScreen and macOS Gatekeeper will warn.
- The desktop app needs Node.js 20+ on PATH and Claude Code installed and logged in.
- On the eval cases so far, a single `claude -p` call matches the loop's pass rate at similar or lower
  cost; the loop's advantages today are unattended safety (checks, rollback, budgets, usage-limit
  waiting). See TODO.md for the measurements.

[Unreleased]: https://github.com/alyn3d/yaaiorch/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/alyn3d/yaaiorch/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/alyn3d/yaaiorch/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/alyn3d/yaaiorch/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/alyn3d/yaaiorch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alyn3d/yaaiorch/releases/tag/v0.1.0
