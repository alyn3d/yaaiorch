# Changelog

All notable changes to YAAIORCH. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) (0.x: anything may change).

## [Unreleased]

## [0.1.0] - 2026-11-11

First public version.

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

[Unreleased]: https://github.com/alyn3d/yaaiorch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alyn3d/yaaiorch/releases/tag/v0.1.0
