# Changelog

All notable changes to YAAIORCH. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) (0.x: anything may change).

## [Unreleased]

### Security
- The browser-mode server could be driven by any web page you visited (it accepted every request on
  `localhost:4317`), for example to start runs on your Claude account. It now refuses requests whose
  `Host` or `Origin` is not local (this also stops DNS rebinding) and requires a per-process session
  token on every `/api` call; the UI fetches it automatically. The desktop app was not affected.

### Changed
- **License: GPL-3.0-only** (was MIT). Versions up to and including 0.2.0 remain available under MIT.

### Added
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

[Unreleased]: https://github.com/alyn3d/yaaiorch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/alyn3d/yaaiorch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alyn3d/yaaiorch/releases/tag/v0.1.0
