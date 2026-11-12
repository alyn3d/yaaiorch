# YAAIORCH (Yet Another AI Orchestrator)

Display name: **YAAIORCH**. Desktop exe `yaaiorch.exe`, Tauri identifier `dev.alinion.yaaiorch`. Internal names stay short
and unchanged on purpose: `orch.ts`, `orch-ui/`, the `.orchestrator/` state dir and `orchestrator/*` git branches in target
repos, `ORCH_*` env vars and the `@@ORCH@@` event marker. Renaming those would break existing target repos and the protocol.

`orch.ts` is a CLI loop: an architect agent plans a goal, then F/E, B/E and other agents build in parallel,
then QA verifies. It repeats until QA passes or max rounds is reached. Built-in agents (`architect`, `fe`,
`be`, `qa`) live in `orch-agents.ts`; agents in `~/.claude/agents` and the target repo's `.claude/agents`
are discovered too and override built-ins of the same name. `orch-ui/` is a React UI that runs in the
browser (via `server.ts`) or as a Tauri v2 desktop app (via `src-tauri`).

## Layout
- `orch.ts`: orchestrator CLI. Must sit next to `orch-ui/` (the UI looks for `../orch.ts`).
- `orch-agents.ts`: built-in agent prompts, bundled into `orch.mjs`. Written to `.orchestrator/builtin-agents.json` at run time and passed to `claude --agents`. Reply formats are appended to prompts by `orch.ts`, not stored here.
- `orch-ui/src`: React + TypeScript + SCSS. `transport.ts` picks HTTP/SSE (browser) or Tauri invoke/events.
- `orch-ui/src/reduce.ts`: folds structured events into the run view.
- `orch-ui/server.ts`: browser-mode server. Spawns orch.ts, forwards events over SSE.
- `orch-ui/src-tauri/src/main.rs`: desktop backend. Spawns the bundled `orch.mjs` with `node` in the chosen repo.

## Event protocol
With `ORCH_EVENTS=1`, orch.ts prints one `@@ORCH@@ {json}` line per event: goal_start, queue_item, round_start,
architect_start, checkpoint, plan, checks, task_start, task_end, round_end, stuck, usage_limit, goal_end, waiting. Keep `server.ts`, `main.rs` and `reduce.ts`
in sync when adding or changing events. The UI also folds a synthetic `stopped` event (from `useOrch.ts`) when the
process exits without `goal_end`.

## Commands (run in `orch-ui`)
- `npm install`
- `npm run tauri dev`: desktop app (builds `src-tauri/resources/orch.mjs` from `../orch.ts` first)
- `npm run build && npm start`: browser mode at http://localhost:4317; `ORCH_REPO=<repo>` or `ORCH_REPOS` opens repos (more via the UI, remembered in `~/.yaaiorch/ui.json`)
- `npm run dev`: browser dev (Vite + server)
- `npm run build`: typecheck + Vite build
- Rust check: `cd src-tauri && cargo check`
- `npm test`: 27 end-to-end scenarios (`test/scenarios.test.mjs`) with the fake claude in `test/fake-claude/`; no tokens. Add a scenario for new loop behaviour.
- Rust spawn test (`#[ignore]`d): `TEST_REPO=<empty dir> ORCH_PATH=<abs path to orch.mjs> CLAUDE_BIN=<repo>/test/fake-claude/claude[.cmd] cargo test -- --ignored`

## Notes
- Windows is the primary target. `orch.ts` spawns `claude` through a shell on win32; children use `windowsHide`.
- Multi-repo UI: both backends keep one session per repo (process, log, events), tag every message with its `repo`, and run at most `maxParallel` repos at once (start queue). One run per repo. Keep `server.ts`, `main.rs` and `transport.ts` in sync. Stop kills that repo's process tree (taskkill on Windows).
- Global state (both backends, `global` / `orch-global` event): a usage limit in any repo holds new starts everywhere until the reset ("Try now" clears it); the optional daily budget sums `cost` from `plan`/`task_end` events, caps each run's `--max-cost` to what is left, holds starts and kills a loop at `queue_item` when used up. Persisted with the repos.
- `.orchestrator/` (queue.json, last-run.json, builtin-agents.json) lives in the target repo and is never committed by the orchestrator.
- Git: a run refuses a dirty tree, creates `orchestrator/checkpoint-*`, and commits each round on the current branch. On pass the checkpoint is deleted. On failure in `loop`, the work moves to `orchestrator/failed-*` and the branch is reset to the checkpoint. `orch rollback` (and the UI button) resets to the checkpoint and keeps the discarded work on `orchestrator/discarded-*`; `orch prune` deletes old `orchestrator/*` branches.
- Headless agents get no shell unless allowed: `claude -p` with `acceptEdits` refuses every Bash/PowerShell call. So orch.ts runs the repo's checks itself (`.orchestrator/config.json` `checks`, else package.json `typecheck`/`lint`/`test`/`build`) and a non-zero exit fails the round. Agents get an allow-list for those commands via `--settings`.
- Read-only roles (architect, verifiers) run with `--permission-mode default` and `readonly-settings.json` (edit tools denied). Deny rules alone are not enough: under `acceptEdits` an agent writes files with a shell redirect instead.
- Limits: `--agent-timeout` (30 min, kills the process tree), `--max-cost` per goal (passed on as `--max-budget-usd`; CLI reports `error_max_budget_usd`). Stuck rounds (no file changed, or same failures again) move up one power tier; two in a row stop the goal.
- `--fast`: round 1 is a single built-in `dev` agent (strong model, no file list) judged by the checks (QA only without checks); failure falls back to the full loop. Eval it as `--power economy+fast`.
- `orch doctor --json` is the first-run check both UIs show as a banner.
- Usage limit ("You've hit your … limit · resets …"): ends the goal as `UsageLimit` (never a task failure or stuck round). `--on-limit wait` (default; config `onLimit`): the work goes to `orchestrator/interrupted-*`, orch waits for the reset and retries (`run` and `loop`). `--on-limit stop`: the goal stays pending and orch exits 3. The eval runner always passes `--on-limit stop` and never records such runs: it stops (or waits with `--wait-on-limit`), and `--resume <stamp>` finishes later.
- Models: `modelFor()` resolves per-agent override > per-role override (`--model`, then config `models`) > power tier. Roles: architect, impl, heavy, qa, dev. On stuck escalation alias overrides step up (haiku → sonnet → opus); full IDs stay. `round_start` carries the effective `models`. The UI's `Settings.tsx` mirrors the tier table for placeholders; keep it in sync with `POWER`.
- Testing without spending tokens: `CLAUDE_BIN=test/fake-claude/claude` (`claude.cmd` on Windows); switches are documented at the top of `fake-claude.mjs`. On Windows `claude` is spawned through cmd.exe, so `shellCmd()` quotes a `CLAUDE_BIN` with spaces; keep that for any new spawn of it.

## Evals (`evals/`, see its README)
- `node evals/run.ts --reference`: checks every case's hidden tests fail on the fixture and pass with the reference. Run after editing a case.
- `node evals/run.ts --cases <ids> --power economy,heavy`: real runs (costs money), graded by hidden tests the agents never see. Results in `evals/results/` (git-ignored).
- Use it to judge prompt, agent or tier changes: compare hidden pass rate, false passes and cost before and after, with `--repeat 3` or more.

## Docs
- `README.md` (users), `CONTRIBUTING.md` (setup, checks, conventions), `docs/ARCHITECTURE.md` (design, event table, data on disk).
- `ROADMAP.md` (milestones), `TODO.md` (open tasks by milestone), `CHANGELOG.md` (what shipped; add to `[Unreleased]` in the same change).
- `docs/review-2026-11.md` is the original code review, kept for history.
- MIT licensed. Open source: never commit personal data, local paths, secrets or eval results.

## Backlog
Next milestone is 0.2 (reliability and trust) in `TODO.md`: finish the eval baseline, harder eval cases, a committed fake `claude` with scenario tests in CI, then hardening (browser CSRF, queue lock, retries, loop budget, graceful stop).
