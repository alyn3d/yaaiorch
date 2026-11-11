# Improvements

Review of `orch.ts`, `orch-ui/` (React, `server.ts`, Tauri `main.rs`) and the docs, done 2026-11-11 by reading the code. Nothing here was run, so each item is a finding from the source, not a reproduced failure.

This complements `TODO.md`. Items already listed there are not repeated, except where the review adds something (see "Notes on existing TODO items" at the end).

Priority: **P0** breaks the loop or gives wrong results, **P1** needed before running unattended, **P2** worthwhile, **P3** later.

## Top five

1. The agents the loop depends on (`architect`, `fe`, `be`, `qa`) are not in this repo.
2. QA never sees new files, and in `loop` each goal's diff and rollback include earlier goals, because nothing is ever committed.
3. "Plan only" plus "Process queue" marks every queued goal as done without building anything.
4. A failed build task leaves the other parallel agents running while the loop moves on.
5. QA is an LLM opinion only. The orchestrator should run the repo's own checks (typecheck, tests, build) and trust exit codes.

## P0: bugs that break the loop or give wrong results

**Status (2026-11-11): all P0 items below are fixed**, except branch-per-goal: work is committed per round on the current branch instead (a failed goal in `loop` is moved to `orchestrator/failed-*`). Built-in agents live in `orch-agents.ts` and are passed with `claude --agents`, rather than as `.claude/agents/*.md` files, so the bundled desktop app has them. Schema-constrained output (`--json-schema`) was not used: passing JSON through the Windows shell is fragile; the prompt contract plus validation and one retry is used instead. Also fixed on the way: `build:orch` was missing `--bundle`. Checked with `npm run build`, `cargo check`, and a fake `claude` in temp git repos; not yet run with the real `claude`.

### Agents are missing
- `ARCHITECTURE.md` and `CLAUDE.md` say agents live in `.claude/agents/`, but there is no `.claude/` folder here. `~/.claude/agents` has only `backend-builder`, `backend-reviewer`, `design-*`, `frontend-*`; there is no `architect` and no `qa`.
- `orch.ts:188` always calls the agent named `architect`, so every run fails at the first step unless the target repo happens to define one.
- Fix: commit `architect.md`, `fe.md`, `be.md`, `qa.md` under `.claude/agents/`, and bundle them with the app. Add a preflight in `runGoalInner` that fails with a clear message when `architect` or any verify-capable agent is missing.

### The output contract lives only in the (missing) agent prompts
- `orch.ts` expects a JSON `Plan`, a JSON `Verdict`, and a `Status: COMPLETE|PARTIAL|FAILED` line, but never asks for them. Any third-party agent discovered in `~/.claude` will not follow the contract.
- Fix: have `orch.ts` append the required output format to every prompt it sends. Check whether the installed CLI supports schema-constrained output (`claude --help`, look for a JSON schema flag) and use it for the plan and the verdict.

### Git handling gives QA and rollback the wrong picture
- **New files are invisible.** `git diff --stat <checkpoint>` (`orch.ts:223`) does not list untracked files, so anything an agent creates is missing from what QA receives. Use `git add -N .` before the diff, or build the list from `git status --porcelain`.
- **Nothing is committed.** The checkpoint is a branch at `HEAD` (`orch.ts:172`), and `HEAD` never moves. In `loop`, goal 2's checkpoint equals goal 1's, so goal 2's diff includes goal 1's work, and `git reset --hard <checkpoint>` after goal 2 also destroys goal 1.
- Fix: work on a branch per goal (`orch/goal-<id>`), commit after each round (or at least after each passed goal), and record the commit in the queue item. This also solves "checkpoint branches pile up" and "dirty working tree" from `TODO.md`: refuse to start on a dirty tree, and delete the checkpoint when the goal passes.

### Dry run marks queue items as done
- `runGoalInner` returns `true` on `--dry-run` (`orch.ts:200`), and `loop` then sets the item to `done` (`orch.ts:271`). The UI passes `dryRun` to both loop buttons (`App.tsx:68-69`).
- Fix: in `loop`, leave the item `pending` on a dry run (or ignore `--dry-run` for `loop`), and disable the loop buttons while "Plan only" is ticked.

### One failing build task orphans the others
- `Promise.all` (`orch.ts:219`) rejects on the first failure. The goal ends, but the other `claude` processes keep editing files. In `loop`, the next goal starts while they are still writing.
- Fix: use `Promise.allSettled`, treat a failed task as a failure to feed into the next round, and keep a list of live child processes so they can be killed when a goal is abandoned.

### Verify errors leave the UI stuck
- If the QA call throws or returns unparsable JSON (`orch.ts:228`), no `task_end` is emitted, so the card stays "running". Wrap it like the build `exec` wrapper and emit `status: "ERROR"`.
- When the process is killed by Stop, no `goal_end` arrives at all. The run view stays "running" with a ticking timer. In `useOrch.ts`, when `state.running` becomes `null` while the run is still "running", mark the run and its unfinished tasks as stopped.

### `run()` does not check the CLI result
- `JSON.parse(out).result` (`orch.ts:98`) is used without checking `is_error` or that `result` is a string. A max-turns or error result gives `undefined`, and `extractJson` then throws a `TypeError` instead of a useful message.
- `out += d` on raw buffers can split a multi-byte character across chunks. Call `p.stdout.setEncoding("utf8")`.

### Browser server splits lines across chunks
- `feed` in `server.ts:78` splits each chunk on newlines with no carry-over. A line that spans two chunks becomes two broken log lines. A large `plan` event is the likely victim: it fails `JSON.parse`, lands in the log as garbage, and the UI never shows the plan.
- Fix: keep the trailing partial line per stream and prepend it to the next chunk (or use `readline`). The Rust side already reads whole lines.

### Rust reader stops on non-UTF-8 output
- `BufReader::lines().map_while(Result::ok)` (`main.rs:178`) ends the reader thread at the first line that is not valid UTF-8. The pipe is then closed, later output is lost, and the child will likely fail on its next write. Windows tools writing in a legacy code page can trigger this.
- Fix: read with `read_until(b'\n')` and convert with `String::from_utf8_lossy`.

### Input validation
- `--max-rounds abc` or a `0` from the UI (empty number field, `App.tsx:51`) gives `NaN`/`0`, the round loop never runs, and the goal reports "max rounds reached" immediately. Validate in `main()` and clamp in the UI.
- An unknown `--power` silently becomes `heavy` (`orch.ts:290`). Reject it.
- `validate()` assumes `plan.tasks` is an array and does not check `phase` values. A plan without `tasks` throws a `TypeError`.

## P1: needed before running unattended

### Loop resilience
- **Stuck `running` items.** After a crash or Stop, the item stays `running` and `loop` only picks `pending` (`orch.ts:258`). On startup, reset `running` items to `pending` (or `failed`), since only one run exists at a time.
- **Retry policy.** A failed goal is never retried and there is no UI to retry it. Add `attempts` to the item, retry up to N times, then park it as `failed` with the last QA failures stored on the item.
- **Blocked state.** Add a `blocked` status for goals that need a human answer, so the loop skips them instead of burning rounds.
- **Stuck detection.** If two consecutive rounds return the same failures, stop early or escalate (see next item) instead of running to max rounds.
- **Model escalation.** On round 3 and later, move one power tier up for the tasks that failed.
- **Budget cap.** An unattended loop has no spending limit. Read cost from the CLI JSON, add `--max-cost` per goal and per loop session, and stop when it is exceeded.
- **Ctrl+C.** `loop` promises "stop after current goal", but a console Ctrl+C is delivered to the child `claude` processes too, so the current goal most likely dies. Ignore the signal in children (spawn detached on POSIX) or document that Ctrl+C aborts. For the UI, use a stop file (`.orchestrator/stop`) that `loop` checks between goals; this gives the graceful stop from `TODO.md` on Windows, where there is no SIGINT to send.

### Deterministic verification

**Status (2026-11-11): done**, pulled forward because the real-claude smoke test showed headless QA cannot run any shell command. Checks come from `.orchestrator/config.json` or package.json scripts; agents get an allow-list via `--settings`.
- Let the target repo declare check commands in `.orchestrator/config.json` (for example `typecheck`, `test`, `lint`, `build`). The orchestrator runs them itself after the build phase, records exit codes, and passes the output to QA. A non-zero exit is a failure regardless of what QA says.
- This extends the existing "trust the diff, not the report" rule to "trust exit codes, not the verdict".

### Context between rounds and between goals
- The architect gets only the failure strings on later rounds (`orch.ts:193`). It does not see its previous plan or what was changed, so it replans from scratch. Pass the previous plan summary, the touched files, and the diff stat.
- Nothing carries over between goals. Add `.orchestrator/notes.md` (decisions, conventions, known pitfalls) that the architect reads at the start and QA appends to at the end. This matters most for a long-running loop on one project.
- For fix rounds, consider resuming the same implementer session (the CLI JSON includes a session id) instead of starting cold.

### Ownership is declared but not enforced
- Paths are compared as raw strings (`orch.ts:118`): `./src/a.ts`, `src\a.ts` and `src/a.ts` count as different files. Normalize (and lower-case on Windows) before comparing.
- After the build phase, compare the changed files against the union of owned files. Report anything changed outside ownership to QA as a failure candidate.
- Build tasks without `files` skip both the ownership and the phantom check. Require `files` for `foundation` and `build` tasks.
- A validation failure throws and ends the goal. Send the error back to the architect once before giving up.

### Read-only roles are not read-only
- Every agent, including `architect` and `qa`, runs with `--permission-mode acceptEdits` (`orch.ts:89`). "Verify never edits" depends on the agent prompt. Run the architect and verify phases with a read-only permission mode or with edit tools disallowed.

### Configuration
- Model names, power tiers, timeouts, check commands and concurrency are hard-coded. Read them from `.orchestrator/config.json` in the target repo, with CLI flags taking priority. This also covers "per-repo settings" from `TODO.md` without app-specific storage.

## P2: backends and UI

### Two backends duplicate the same logic
- `server.ts` and `main.rs` both implement spawn, line parsing, log ring, event buffer, stop and snapshot. Every protocol change must be made twice, plus `reduce.ts`.
- Option: since Node is already required at runtime, let the Tauri app start `server.ts` and point the webview at it. That removes most of `main.rs` and the transport split. Cost: the local-CSRF item in `TODO.md` then applies to the desktop app as well, so the token check must be done first.
- If both stay: move line parsing and event buffering into `orch.ts` itself (write events to `.orchestrator/runs/<id>.jsonl`) and let both backends tail that file. This also gives run history for free.

### `server.ts`
- "Already running" returns 500 (`server.ts:68`, caught at `:185`). Return 409.
- `/api/agents` uses `execFileSync` (`server.ts:148`) and blocks the event loop, including the SSE stream, while it runs. Use the async form.
- `body()` has no size limit.
- The static path check `file.startsWith(DIST)` (`server.ts:180`) also accepts a sibling folder whose name starts with `dist`. Compare against `DIST + path.sep`.
- Only `SIGINT` and `exit` are handled (`server.ts:190-191`). Closing the terminal on Windows can leave `orch.ts` and its agents running. Handle `SIGTERM`, `SIGHUP` and `SIGBREAK`.

### `main.rs`
- `add_goal` and `agents` are synchronous commands that run `node` with `.output()`. Synchronous Tauri commands run on the main thread, so the window freezes while Node starts. Mark them `async` or use `#[tauri::command(async)]`.
- `stop` and the exit handler run `taskkill` while holding the state mutex (`main.rs:294`, `:327`). Copy the pid out, release the lock, then kill.
- `set_repo` keeps the previous repo's log and events. Clear them on switch.
- `"csp": null` in `tauri.conf.json`. Set a restrictive CSP; the app loads only local content.
- The test passes silently when the env vars are unset. Mark it `#[ignore]` and run it explicitly in CI, so a green result means it ran.

### UI
- The log re-renders 5000 joined lines on every new line (`useOrch.ts:22`, `App.tsx:110`). Batch updates per animation frame and render only the visible part.
- Auto-scroll always jumps to the bottom (`App.tsx:16-19`). Skip it when the user has scrolled up.
- "Add to queue" clears the textarea even when the call fails (`App.tsx:57`). Clear only on success.
- Queue management is missing: remove, reorder, retry failed, clear finished.
- Show the stored checkpoint/commit and failures on each finished queue item.

## P2: larger design options

- **Self-feeding backlog.** For "future project developments", add a planner step that reads a roadmap file in the target repo (for example `BACKLOG.md`) and enqueues the next goals when the queue is empty. Queue items then need `priority`, `dependsOn`, per-item `power`/`maxRounds`, timestamps and a result summary.
- **Pull request as the output.** With a branch per goal, finish a passed goal by pushing and opening a PR (`gh pr create`) instead of leaving changes in the working tree. A human then reviews at the PR level and the loop never touches the main branch.
- **Worktrees for parallel tasks.** All build agents share one working tree, so one agent's half-written file can break another agent's typecheck or test run. A git worktree per build task, merged after the phase (trivial with exclusive file ownership), removes that interference.
- **Sturdier JSON extraction.** `extractJson` takes the first `{` to the last `}` (`orch.ts:108`). Prose containing braces before the JSON breaks it. Prefer a fenced `json` block when present, then fall back to the current method.

## P3: housekeeping

- This folder is not a git repository. Run `git init` and commit; the orchestrator's own rollback story depends on git, and so should its development.
- The usage text is printed by reading the script's own source (`orch.ts:314`). In the bundled `orch.mjs` the header comment is likely stripped, so the desktop build prints nothing useful. Keep the usage in a string constant.
- `shell: true` on Windows (`orch.ts:90`) with an argument array triggers a deprecation warning on current Node versions. Resolve the `claude` executable path once and spawn it directly.
- `orch-ui/README.md` shows `set ORCH_REPO=C:\path && npm start`. In `cmd` this puts a trailing space in the value. Use `set "ORCH_REPO=C:\path" && npm start`.
- Update `ARCHITECTURE.md` and `CLAUDE.md` once the agents are committed, so the docs match the repo.

## Notes on existing TODO items

- **Timeouts in `run()`** (P1 in `TODO.md`): on timeout, kill the process tree, not just the child, because `claude` runs under a shell on Windows.
- **Queue write races**: also write through a temp file and rename, so a crash mid-write cannot leave a truncated `queue.json` (which `readQueue` would then fail to parse).
- **Run history**: an append-only `.orchestrator/runs/<id>.jsonl` of the structured events is enough; the UI can replay it through `reduce.ts` unchanged.
- **Cost and tokens**: the same data is what the budget cap above needs, so do them together.
- **Shared event types**: a discriminated union in one file imported by `orch.ts` and the UI would remove the `any` in `reduce.ts:28` and `types.ts:8`.

## Suggested order

1. ~~Commit the agents and add the preflight and prompt-side output contract.~~ Done.
2. ~~Fix git handling: commit per round, include untracked files in the diff.~~ Done.
3. ~~Fix the dry-run, `Promise.all`, verify-error and stuck-`running` bugs.~~ Done.
4. ~~Add orchestrator-run check commands and the config file.~~ Done.
5. Add timeouts, budget cap, retry policy and stuck detection.
6. Then decide on one backend versus two before adding more UI features.
