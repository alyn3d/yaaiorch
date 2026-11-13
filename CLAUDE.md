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
- `claude-bin.ts`: finds the `claude` executable once (Windows: an .exe directly, an npm .cmd shim unwrapped to node + its script), shared by `orch.ts` and `evals/run.ts`.
- `orch-agents.ts`: built-in agent prompts, bundled into `orch.mjs`. Written to `.orchestrator/builtin-agents.json` at run time and passed to `claude --agents`. Reply formats are appended to prompts by `orch.ts`, not stored here.
- `orch-ui/src`: React + TypeScript + SCSS. `transport.ts` picks HTTP/SSE (browser) or Tauri invoke/events.
- `orch-ui/src/reduce.ts`: folds structured events into the run view.
- `orch-ui/server.ts`: browser-mode server. Spawns orch.ts, forwards events over SSE.
- `orch-ui/src-tauri/src/main.rs`: desktop backend. Spawns the bundled `orch.mjs` with `node` in the chosen repo.

## Event protocol
With `ORCH_EVENTS=1`, orch.ts prints one `@@ORCH@@ {json}` line per event: goal_start, queue_item, round_start,
architect_start, checkpoint, plan, checks, task_start, task_end, round_end, stuck, critic, review, split_proposal, coverage, retry, blocked, queue_changed, resumed, approval_wait, approval, goal_branch, pr, learn_start, learn_end, notes_tidy, share_start, share_end, loop_stop, unowned, usage_limit, goal_end, waiting, usage. Keep `server.ts`, `main.rs` and `reduce.ts`
in sync when adding or changing events. The UI also folds a synthetic `stopped` event (from `useOrch.ts`) when the
process exits without `goal_end`.

## Commands (run in `orch-ui`)
- `npm install`
- `npm run tauri dev`: desktop app (builds `src-tauri/resources/orch.mjs` from `../orch.ts` first)
- `npm run build && npm start`: browser mode at http://localhost:4317; `ORCH_REPO=<repo>` or `ORCH_REPOS` opens repos (more via the UI, remembered in `~/.yaaiorch/ui.json`)
- `npm run dev`: browser dev (Vite + server)
- `npm run build`: typecheck + Vite build
- `npm run lint` (ESLint, whole repo, config `orch-ui/eslint.config.mjs`), `npm run format` / `format:check` (Prettier, printWidth 160, `.prettierignore` at the root: code only, never eval fixtures). CI fails on either.
- Rust: `cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings` (`rustfmt.toml`: max_width 160)
- `npm test`: 66 end-to-end scenarios (`test/scenarios.test.mjs`) with the fake claude in `test/fake-claude/`, the browser server's request guard (`test/server.test.mjs`) and unit tests of orch.ts helpers, `claude-bin.ts` and the UI's `reduce.ts`, `progress.ts`, `notifyText.ts` (`test/unit.test.mjs`, importing orch.ts with `ORCH_NO_MAIN=1`); no tokens. Add a scenario for new loop behaviour.
- Rust spawn test (`#[ignore]`d): `TEST_REPO=<empty dir> ORCH_PATH=<abs path to orch.mjs> CLAUDE_BIN=<repo>/test/fake-claude/claude[.cmd] cargo test -- --ignored`

## Notes
- Windows is the primary target. `claude` is spawned without a shell (`spawnClaude` / `claudeSync` in orch.ts, `resolveClaude` in `claude-bin.ts`); cmd.exe only as a fallback for a .cmd shim it cannot read. PATH is searched, never the current directory. Children use `windowsHide`.
- Browser-mode server guard: `refuse()` in `server.ts` checks a local `Host` and `Origin` and a per-process token (`x-orch-token`, or `?token=` for SSE) on every `/api` call; the UI gets it from `/api/token` (`transport.ts`). Any new route is covered automatically; never add an `/api` route before the guard.
- Multi-repo UI: both backends keep one session per repo (process, log, events), tag every message with its `repo`, and run at most `maxParallel` repos at once (start queue). One run per repo. Keep `server.ts`, `main.rs` and `transport.ts` in sync. Stop kills that repo's process tree (taskkill on Windows).
- Plugins: headless agents load the user's Claude Code plugins and hooks. `--plugins off` / `--disable-plugins` / `--no-hooks` (config `plugins`) write `enabledPlugins: {id: false}` and `disableAllHooks` into the agents' `--settings` files (not `--bare`, which drops the OAuth login). `orch plugins --json --details` lists them via `claude plugin list --json` and `claude plugin details`.
- Usage caps: agents run with `stream-json`; orch reads the CLI's `rate_limit_event` (5-hour and weekly `utilization`, undocumented) into `usage` events and, with `--usage-cap 5h=N,week=M` (config `usageCap`), pauses before an agent call (or stops, with `--on-limit stop`) while a reading is over a cap. The backends pass their global caps to every run and hold new starts too.
- Global state (both backends, `global` / `orch-global` event): a usage limit in any repo holds new starts everywhere until the reset ("Try now" clears it); the optional daily budget sums `cost` from `plan`/`task_end` events, caps each run's `--max-cost` to what is left, holds starts and kills a loop at `queue_item` when used up. Persisted with the repos.
- `.orchestrator/` (queue.json, last-run.json, builtin-agents.json) lives in the target repo and is never committed by the orchestrator. State files go through `writeFileAtomic`; queue edits through `updateQueue` (queue.lock); `run`/`loop`/`learn`/`rollback` take `run.lock` (`acquireRunLock`). Never write queue.json directly, from orch or a backend (the browser server adds goals via `orch add`). `validate()` rejects plan paths outside the repo, in `.git`/`.orchestrator`, or through a link (`badPath`).
- Notifications: `orch-ui/src/notifyText.ts` (pure, unit-tested) picks the events, `notify.ts` sends them (Tauri `tauri-plugin-notification`, capability `notification:default`, or the browser Notification API); called from `useOrch.ts` for live events only.
- Big briefs: `orch split` (`splitBrief` / `acceptSplit`, `--propose`, `--accept` from stdin, `--start`) and `orch new` share one splitter; the brief lives in `.orchestrator/spec.md` (read by every architect via `specForPrompt`), queue items from it carry `fromSpec`, and `coverageCheck` runs when the loop's queue is empty (two passes per brief, `.orchestrator/spec-state.json`). UI: `Brief.tsx`, the proposal comes from a `split_proposal` event without `queued` (`Session.proposal`). **+ New project** (`NewProject.tsx`) calls the backends' `new_project` / `/api/new-project`: they create `<parent>/<name>` (a plain name), open it as a repo and start `orch new .` there with the spec in a temp file.
- Interrupted goals resume from their parked work: `lastParked` (set by `finishGit` / `finishGoalBranch`), queue item `resumeFrom`, `applyParked` after the checkpoint, and a note to the architect.
- Queue dependencies: items have `after` (ids), `brief`, `attempts`, `power`, `cost`, `seconds`, `resumeFrom`; status `blocked`. `nextRunnable` / `blockDependents` / `retryGoal` (`orch retry ID`); `--retries` (default 1) re-runs a failed goal a tier up, never after `BudgetExceeded`. With `--branch`, a brief's goals share `orch/brief-<id>` (`startGoalBranch(goal, id, brief)`), failed ones are parked, one PR per brief (`briefPullRequest`).
- Daily budget left goes to `loop` / `new --start` as `--max-cost-total` (`withBudget` in both backends), else as `--max-cost`. Links out of the desktop app go through `tauri-plugin-opener` (`opener:default`).
- Progress: `orch-ui/src/progress.ts` (pure, unit-tested) from the queue; backends re-send the queue on `queue_item`, `queue_changed`, `blocked`, `coverage`. The UI's queue **Budget $** and New project **Total $** pass `maxCostTotal` (`--max-cost-total`).
- Greenfield: `orch new` (`newProject`) creates the repo, seeds the brief and queues the architect's goals; checks are re-read every round (`refreshChecks`); config `setup` runs in `runSetup` before the checks when a manifest changed (hash in `.orchestrator/setup-state.json`), new untracked dirs go to `.git/info/exclude`. Agents never install.
- Plan approval (`--approve-plan`): `awaitDecision` writes `.orchestrator/plan-pending.json` and polls `plan-decision.json`, which only `orch approve` writes (backends call it; an edited plan goes on stdin). A rejection re-plans with the human's reason.
- Branch per goal (`--branch`, `--pr`): `startGoalBranch` / `finishGoalBranch` / `openPullRequest`; the base branch never moves, the checkpoint is deleted at the end, `gh` is resolved with `resolveCommand` (`GH_BIN`, fake in `test/fake-gh/`) and gets the PR body on stdin.
- Git: a run refuses a dirty tree, creates `orchestrator/checkpoint-*`, and commits each round on the current branch. On pass the checkpoint is deleted, but only if everything got committed (a failed commit keeps it). Parking commits (`moveWorkAside`, side branches only) use `--no-verify` so hooks never block recovery; round commits respect hooks. On failure in `loop`, the work moves to `orchestrator/failed-*` and the branch is reset to the checkpoint. `orch rollback` (and the UI button) resets to the checkpoint and keeps the discarded work on `orchestrator/discarded-*`; `orch prune` deletes old `orchestrator/*` branches.
- Headless agents get no shell unless allowed: `claude -p` with `acceptEdits` refuses every Bash/PowerShell call. So orch.ts runs the repo's checks itself (`.orchestrator/config.json` `checks`, else package.json `typecheck`/`lint`/`test`/`build`) and a non-zero exit fails the round. Agents get an allow-list for those commands via `--settings`.
- Read-only roles (architect, verifiers) run with `--permission-mode default` and `readonly-settings.json` (edit tools denied). Deny rules alone are not enough: under `acceptEdits` an agent writes files with a shell redirect instead.
- Limits: `--agent-timeout` (30 min, kills the process tree), `--max-cost` per goal (each call reserves its share of what is left and gets it as `--max-budget-usd`; parallel build tasks split it equally; CLI reports `error_max_budget_usd`). Stuck rounds (no file changed, or same failures again) move up one power tier: only the failing tasks' agents when others completed (`agentPower`), else the whole round; two in a row stop the goal. Fix rounds give the architect `previousRound()` (plan, task statuses, diff stat); `.orchestrator/brief.md` is the architect's project brief (commit-stamped; checked again after 20+ changed files; `orch learn` writes it up front), reused across rounds, goals and all agents via `ctx.repoContext` (`--no-brief`); `.orchestrator/notes.md` collects lessons between goals (`appendNotes`, `--no-notes`). `--critic`: the built-in read-only `critic` agent reviews each plan once (event `critic`). Diff reviews next to QA (event `review`, skipped when a check or task failed): `--diff-critic` (critic, lens goal) and `--review` (built-in `reviewer`, or `--reviewers A,B`, lens bugs); a rejection fails the round. The critic, `reviewer` and named reviewers are excluded from the architect's roster. `tidyNotes` merges notes.md past 5000 characters (event `notes_tidy`); `orch share` commits a CLAUDE.md section (between `yaaiorch:learned` markers) on an `orchestrator/claude-md-*` branch with git plumbing, never touching the working tree. Backends count the cost of plan, task_end, review, learn_end, notes_tidy and share_end.
- Transient API errors (`TRANSIENT_RE`) are retried once in `run()`; files changed outside every task's list are reported (`unowned`; `--strict-files` fails the round); `--max-cost-total` caps a whole `loop`. Export new pure helpers at the bottom of orch.ts for unit tests.
- Session resume (`--no-resume`, config `resume`): a fix round's implementer task continues the session (`--resume <id> --fork-session`) of the same agent's task from the round before that shares a file with it (`pickSession`); the prompt is then the task alone. Not after a stuck round (fresh look), never for QA or the architect; a failed resume starts cold once; a phantom retry continues its own session with a nudge. `task_start` carries `resumed: <round>`.
- `--fast`: round 1 is a single built-in `dev` agent (strong model, no file list) judged by the checks (QA only without checks); failure falls back to the full loop. Eval it as `--power economy+fast`.
- `orch doctor --json` is the first-run check both UIs show as a banner.
- Usage limit ("You've hit your … limit · resets …"): ends the goal as `UsageLimit` (never a task failure or stuck round). `--on-limit wait` (default; config `onLimit`): the work goes to `orchestrator/interrupted-*`, orch waits for the reset and retries (`run` and `loop`). `--on-limit stop`: the goal stays pending and orch exits 3. The eval runner always passes `--on-limit stop` and never records such runs: it stops (or waits with `--wait-on-limit`), and `--resume <stamp>` finishes later.
- Models: `modelFor()` resolves per-agent override > per-role override (`--model`, then config `models`) > power tier. Roles: architect, impl, heavy, qa, dev. On stuck escalation alias overrides step up (haiku → sonnet → opus); full IDs stay. `round_start` carries the effective `models`. The UI's `Settings.tsx` mirrors the tier table for placeholders; keep it in sync with `POWER`.
- Testing without spending tokens: `CLAUDE_BIN=test/fake-claude/claude` (`claude.cmd` on Windows); switches are documented at the top of `fake-claude.mjs`. Spawn `claude` only through `spawnClaude` / `claudeSync` (or `resolveClaude`), never with `shell: true`.

## Evals (`evals/`, see its README)
- `node evals/run.ts --reference`: checks every case's hidden tests fail on the fixture and pass with the reference. Run after editing a case.
- `node evals/run.ts --cases <ids> --power economy,heavy`: real runs (costs money), graded by hidden tests the agents never see. Results in `evals/results/` (git-ignored).
- Use it to judge prompt, agent or tier changes: compare hidden pass rate, false passes and cost before and after, with `--repeat 3` or more.
- Config suffixes: `economy+fast`, `+nomem` (no brief or notes), `+critic`, `+noresume`, `+diffcritic`, `+review`, combinable. Series cases (`goals: [...]` in `cases.json`) run each goal in turn on one repo and grade at the end; they measure the brief and notes (`--power economy,economy+nomem`).

## Docs
- `README.md` (users), `CONTRIBUTING.md` (setup, checks, conventions), `docs/ARCHITECTURE.md` (design, event table, data on disk).
- `ROADMAP.md` (milestones), `TODO.md` (open tasks by milestone), `CHANGELOG.md` (what shipped; add to `[Unreleased]` in the same change).
- `docs/review-2026-11.md` is the original code review, kept for history.
- GPL-3.0-only (up to 0.2.0: MIT). Open source: never commit personal data, local paths, secrets or eval results.

## Backlog
0.4.0 shipped whole projects (big briefs, `orch new`, goal dependencies, retries, a shared brief branch and PR, queue budget and progress) and better rounds (session resume, diff critic, review lens, notes tidy and share, plan approval, notifications). Still open in `TODO.md`: measuring all of it on the evals (series, greenfield, multi-round cases) and the baseline; then the rest of 0.5 (backlog intake, worktrees, sandboxing).
