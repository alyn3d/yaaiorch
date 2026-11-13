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
architect_start, checkpoint, plan, checks, task_start, task_end, round_end, stuck, critic, learn_start, learn_end, loop_stop, unowned, usage_limit, goal_end, waiting, usage. Keep `server.ts`, `main.rs` and `reduce.ts`
in sync when adding or changing events. The UI also folds a synthetic `stopped` event (from `useOrch.ts`) when the
process exits without `goal_end`.

## Commands (run in `orch-ui`)
- `npm install`
- `npm run tauri dev`: desktop app (builds `src-tauri/resources/orch.mjs` from `../orch.ts` first)
- `npm run build && npm start`: browser mode at http://localhost:4317; `ORCH_REPO=<repo>` or `ORCH_REPOS` opens repos (more via the UI, remembered in `~/.yaaiorch/ui.json`)
- `npm run dev`: browser dev (Vite + server)
- `npm run build`: typecheck + Vite build
- Rust check: `cd src-tauri && cargo check`
- `npm test`: 47 end-to-end scenarios (`test/scenarios.test.mjs`) with the fake claude in `test/fake-claude/`, the browser server's request guard (`test/server.test.mjs`) and unit tests of orch.ts helpers (`test/unit.test.mjs`, importing orch.ts with `ORCH_NO_MAIN=1`); no tokens. Add a scenario for new loop behaviour.
- Rust spawn test (`#[ignore]`d): `TEST_REPO=<empty dir> ORCH_PATH=<abs path to orch.mjs> CLAUDE_BIN=<repo>/test/fake-claude/claude[.cmd] cargo test -- --ignored`

## Notes
- Windows is the primary target. `orch.ts` spawns `claude` through a shell on win32; children use `windowsHide`.
- Browser-mode server guard: `refuse()` in `server.ts` checks a local `Host` and `Origin` and a per-process token (`x-orch-token`, or `?token=` for SSE) on every `/api` call; the UI gets it from `/api/token` (`transport.ts`). Any new route is covered automatically; never add an `/api` route before the guard.
- Multi-repo UI: both backends keep one session per repo (process, log, events), tag every message with its `repo`, and run at most `maxParallel` repos at once (start queue). One run per repo. Keep `server.ts`, `main.rs` and `transport.ts` in sync. Stop kills that repo's process tree (taskkill on Windows).
- Plugins: headless agents load the user's Claude Code plugins and hooks. `--plugins off` / `--disable-plugins` / `--no-hooks` (config `plugins`) write `enabledPlugins: {id: false}` and `disableAllHooks` into the agents' `--settings` files (not `--bare`, which drops the OAuth login). `orch plugins --json --details` lists them via `claude plugin list --json` and `claude plugin details`.
- Usage caps: agents run with `stream-json`; orch reads the CLI's `rate_limit_event` (5-hour and weekly `utilization`, undocumented) into `usage` events and, with `--usage-cap 5h=N,week=M` (config `usageCap`), pauses before an agent call (or stops, with `--on-limit stop`) while a reading is over a cap. The backends pass their global caps to every run and hold new starts too.
- Global state (both backends, `global` / `orch-global` event): a usage limit in any repo holds new starts everywhere until the reset ("Try now" clears it); the optional daily budget sums `cost` from `plan`/`task_end` events, caps each run's `--max-cost` to what is left, holds starts and kills a loop at `queue_item` when used up. Persisted with the repos.
- `.orchestrator/` (queue.json, last-run.json, builtin-agents.json) lives in the target repo and is never committed by the orchestrator. State files go through `writeFileAtomic`; queue edits through `updateQueue` (queue.lock); `run`/`loop`/`learn`/`rollback` take `run.lock` (`acquireRunLock`). Never write queue.json directly, from orch or a backend (the browser server adds goals via `orch add`). `validate()` rejects plan paths outside the repo, in `.git`/`.orchestrator`, or through a link (`badPath`).
- Git: a run refuses a dirty tree, creates `orchestrator/checkpoint-*`, and commits each round on the current branch. On pass the checkpoint is deleted, but only if everything got committed (a failed commit keeps it). Parking commits (`moveWorkAside`, side branches only) use `--no-verify` so hooks never block recovery; round commits respect hooks. On failure in `loop`, the work moves to `orchestrator/failed-*` and the branch is reset to the checkpoint. `orch rollback` (and the UI button) resets to the checkpoint and keeps the discarded work on `orchestrator/discarded-*`; `orch prune` deletes old `orchestrator/*` branches.
- Headless agents get no shell unless allowed: `claude -p` with `acceptEdits` refuses every Bash/PowerShell call. So orch.ts runs the repo's checks itself (`.orchestrator/config.json` `checks`, else package.json `typecheck`/`lint`/`test`/`build`) and a non-zero exit fails the round. Agents get an allow-list for those commands via `--settings`.
- Read-only roles (architect, verifiers) run with `--permission-mode default` and `readonly-settings.json` (edit tools denied). Deny rules alone are not enough: under `acceptEdits` an agent writes files with a shell redirect instead.
- Limits: `--agent-timeout` (30 min, kills the process tree), `--max-cost` per goal (each call reserves its share of what is left and gets it as `--max-budget-usd`; parallel build tasks split it equally; CLI reports `error_max_budget_usd`). Stuck rounds (no file changed, or same failures again) move up one power tier: only the failing tasks' agents when others completed (`agentPower`), else the whole round; two in a row stop the goal. Fix rounds give the architect `previousRound()` (plan, task statuses, diff stat); `.orchestrator/brief.md` is the architect's project brief (commit-stamped; checked again after 20+ changed files; `orch learn` writes it up front), reused across rounds, goals and all agents via `ctx.repoContext` (`--no-brief`); `.orchestrator/notes.md` collects lessons between goals (`appendNotes`, `--no-notes`). `--critic`: the built-in read-only `critic` agent reviews each plan once (event `critic`); it is excluded from the architect's roster.
- Transient API errors (`TRANSIENT_RE`) are retried once in `run()`; files changed outside every task's list are reported (`unowned`; `--strict-files` fails the round); `--max-cost-total` caps a whole `loop`. Export new pure helpers at the bottom of orch.ts for unit tests.
- `--fast`: round 1 is a single built-in `dev` agent (strong model, no file list) judged by the checks (QA only without checks); failure falls back to the full loop. Eval it as `--power economy+fast`.
- `orch doctor --json` is the first-run check both UIs show as a banner.
- Usage limit ("You've hit your … limit · resets …"): ends the goal as `UsageLimit` (never a task failure or stuck round). `--on-limit wait` (default; config `onLimit`): the work goes to `orchestrator/interrupted-*`, orch waits for the reset and retries (`run` and `loop`). `--on-limit stop`: the goal stays pending and orch exits 3. The eval runner always passes `--on-limit stop` and never records such runs: it stops (or waits with `--wait-on-limit`), and `--resume <stamp>` finishes later.
- Models: `modelFor()` resolves per-agent override > per-role override (`--model`, then config `models`) > power tier. Roles: architect, impl, heavy, qa, dev. On stuck escalation alias overrides step up (haiku → sonnet → opus); full IDs stay. `round_start` carries the effective `models`. The UI's `Settings.tsx` mirrors the tier table for placeholders; keep it in sync with `POWER`.
- Testing without spending tokens: `CLAUDE_BIN=test/fake-claude/claude` (`claude.cmd` on Windows); switches are documented at the top of `fake-claude.mjs`. On Windows `claude` is spawned through cmd.exe, so `shellCmd()` quotes a `CLAUDE_BIN` with spaces; keep that for any new spawn of it.

## Evals (`evals/`, see its README)
- `node evals/run.ts --reference`: checks every case's hidden tests fail on the fixture and pass with the reference. Run after editing a case.
- `node evals/run.ts --cases <ids> --power economy,heavy`: real runs (costs money), graded by hidden tests the agents never see. Results in `evals/results/` (git-ignored).
- Use it to judge prompt, agent or tier changes: compare hidden pass rate, false passes and cost before and after, with `--repeat 3` or more.
- Config suffixes: `economy+fast`, `+nomem` (no brief or notes), `+critic`, combinable. Series cases (`goals: [...]` in `cases.json`) run each goal in turn on one repo and grade at the end; they measure the brief and notes (`--power economy,economy+nomem`).

## Docs
- `README.md` (users), `CONTRIBUTING.md` (setup, checks, conventions), `docs/ARCHITECTURE.md` (design, event table, data on disk).
- `ROADMAP.md` (milestones), `TODO.md` (open tasks by milestone), `CHANGELOG.md` (what shipped; add to `[Unreleased]` in the same change).
- `docs/review-2026-11.md` is the original code review, kept for history.
- GPL-3.0-only (up to 0.2.0: MIT). Open source: never commit personal data, local paths, secrets or eval results.

## Backlog
0.3.0 shipped reliability (locks, retries, path checks, loop budget, server guard) and repo memory (brief, notes, `orch learn`, critic). Still open from 0.3 in `TODO.md`: the eval baseline, measuring the memory features on the series cases, lint/format in CI, and spawning `claude` without a shell on Windows; then 0.4.
