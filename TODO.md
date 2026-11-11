# YAAIORCH TODO

Priority: **P0** blocks real use, **P1** important, **P2** worthwhile, **P3** later.

## P0: verify before trusting it

- [x] **First Windows build and run.** Done 2026-11-11 on Windows 11 (Tauri 2.12, WebView2 157, MSVC 2022):
  - `cargo test` spawn/event test passes on Windows with a fake `claude`.
  - `npm run tauri dev` opens the window in about 24 s; the Tauri transport connects.
  - `npm run tauri build` produces the app exe (`yaaiorch.exe` since the rename, `orch-app.exe` at the time), an MSI and an NSIS setup. The release exe launches, and `resources/orch.mjs` is bundled next to it.
  - A real goal ran end to end with the real `claude` from the CLI. The browser-mode UI was exercised with a fake `claude`: run, checks badge, checkpoint, Stop.
  - Not done: a goal driven from the desktop window itself (the native folder picker needs a person), and installing from the MSI/NSIS.
- [x] **Headless permissions.** Confirmed in a real run (claude 2.1.322): with `acceptEdits` in `-p` mode every Bash and PowerShell call is refused, so QA could never pass. Fixed: orch.ts runs the checks itself and passes an allow-list with `--settings`. Compound commands (`cd x && npm test; echo $?`) are still refused; that is expected.
- [x] **Real-run check of the `claude` JSON output.** `result` and `is_error` work as read by `run()`, and `--agents <file>` + `--agent` resolve built-in agents. Smoke test (economy power, slugify goal in a throwaway repo) passed in one round.

## P1: correctness and safety

- [ ] **Local CSRF in browser mode.** `server.ts` accepts any request on localhost and parses the body as JSON without checking `Content-Type` or `Origin`. A web page can POST `/api/run` and start agents. Add an Origin/Host check and a per-session token.
- [x] **Timeouts in `run()`.** `--agent-timeout` (30 min) kills the process tree; a failed call is a task error, not the end of the goal. Still open: one retry for transient failures (network, rate limit).
- [x] **Architect JSON failures.** Bad JSON or a rejected plan is sent back once with the reason.
- [x] **Stop mid-edit leaves a half-changed tree.** `orch rollback` and a UI button (two-step confirm) reset to the checkpoint; the discarded work is kept on `orchestrator/discarded-*`.
- [x] **Checkpoint branches pile up.** Deleted on pass, park and rollback; `orch prune --older-than DAYS` removes old `orchestrator/*` branches; doctor warns about leftovers.
- [ ] **Queue write races.** UI `add` and the loop both read-modify-write `queue.json`. Use a lock file or route all writes through one process.
- [x] **Dirty working tree.** A run refuses to start on uncommitted changes (`.orchestrator/` excluded).

## P1: UI gaps

- [ ] Show which queue goal is currently running (use the `queue_item` event).
- [ ] Graceful "stop after current goal" for `loop`. Today Stop kills the process tree.
- [ ] Per-task agent output. The full report is not emitted; add a truncated `output` to `task_end` and show it expandable on the card.
- [ ] Persist run history (events per goal) to `.orchestrator/runs/` and list past runs. Today only the latest `last-run.json` survives and live events vanish on restart.
- [x] Cost per task, round and goal (from `total_cost_usd`), shown in the run panel and last-run card, with a `--max-cost` budget per goal. Tokens are not shown yet.

## P2: features

- [ ] **Plan approval gate.** Optional pause after the architect plan so a human can approve or edit it before build (extends `--dry-run`).
- [ ] Diff viewer per round (files changed, link to `git diff`).
- [ ] Agent roster page: view and edit `.claude/agents/*.md`, show discovered skills.
- [ ] Goal templates and a Figma link field that passes through to the `fe` task.
- [ ] Notifications when a goal finishes or fails (desktop notification in Tauri).
- [ ] Concurrency cap for parallel build tasks.
- [ ] Per-repo settings (power, max rounds) remembered by the desktop app.

## P2: quality

- [ ] Unit tests for `reduce.ts` and for `validate`, `extractJson`, `execute` in `orch.ts` (needs exports or a test seam).
- [ ] CI: typecheck, `cargo check`, the Rust spawn test with the fake `claude` (keep a copy of the fake in the repo).
- [ ] Make the fake `claude` a committed test fixture instead of living in `/tmp`. It must now accept `--agents <file>` (built-in agents are passed that way). The P0 fixes were checked with such a fake covering: happy path, QA seeing new files, loop parking a failed goal, a crashing build task, dirty-tree refusal, plan retry, and CLI input validation.
- [ ] Share the event types between `orch.ts` and the UI instead of duplicating shapes.
- [ ] Lint and format config (ESLint, Prettier, rustfmt, clippy).

## P3: packaging

- [ ] Windows installer build and code signing.
- [ ] Bundle Node as a sidecar so the app does not require Node on PATH.
- [ ] Auto-update.
- [x] First-run checks: `orch doctor` (node, claude installed and logged in, git, clean repo, leftover checkpoints, checks), shown as a banner in both UIs.

## Done

- [x] Eval suite (`evals/`): 10 cases over 3 dependency-free fixtures (Node lib, Node API, Python), hidden tests plus reference solutions, `--reference` self-check, runner with per-tier tables and false-pass count. First real run (economy, 3 cases): 3/3 hidden pass, 1 round each, $0.92 total.

- [x] `orch.ts` loop: architect, foundation, parallel build, QA, rounds, queue, power tiers.
- [x] Phantom-completion detection and checkpoint branches.
- [x] Structured event protocol (`ORCH_EVENTS`).
- [x] Browser UI with live task cards (`server.ts`).
- [x] Tauri v2 desktop app with repo picker, shared transport layer.
- [x] Rust spawn/event test with fake `claude`.
