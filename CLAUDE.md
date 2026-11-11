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
architect_start, checkpoint, plan, checks, task_start, task_end, round_end, goal_end. Keep `server.ts`, `main.rs` and `reduce.ts`
in sync when adding or changing events. The UI also folds a synthetic `stopped` event (from `useOrch.ts`) when the
process exits without `goal_end`.

## Commands (run in `orch-ui`)
- `npm install`
- `npm run tauri dev`: desktop app (builds `src-tauri/resources/orch.mjs` from `../orch.ts` first)
- `npm run build && npm start`: browser mode at http://localhost:4317, with `ORCH_REPO=<target repo>`
- `npm run dev`: browser dev (Vite + server)
- `npm run build`: typecheck + Vite build
- Rust check: `cd src-tauri && cargo check`
- Rust test (skipped unless env is set): `TEST_REPO=<empty dir> ORCH_PATH=<abs path to orch.mjs> CLAUDE_BIN=<fake claude script> cargo test`

## Notes
- Windows is the primary target. `orch.ts` spawns `claude` through a shell on win32; children use `windowsHide`.
- Only one run at a time. Stop kills the whole process tree (taskkill on Windows).
- `.orchestrator/` (queue.json, last-run.json, builtin-agents.json) lives in the target repo and is never committed by the orchestrator.
- Git: a run refuses a dirty tree, creates `orchestrator/checkpoint-*`, and commits each round on the current branch. On pass the checkpoint is deleted. On failure in `loop`, the work moves to `orchestrator/failed-*` and the branch is reset to the checkpoint.
- Headless agents get no shell unless allowed: `claude -p` with `acceptEdits` refuses every Bash/PowerShell call. So orch.ts runs the repo's checks itself (`.orchestrator/config.json` `checks`, else package.json `typecheck`/`lint`/`test`/`build`) and a non-zero exit fails the round. Agents get an allow-list for those commands via `--settings .orchestrator/agent-settings.json`.
- Testing without spending tokens: point `CLAUDE_BIN` at a fake `claude` that reads the prompt on stdin and prints `{"result": "...", "is_error": false}`. It must accept `--agents <file>`.

## Backlog
1. "Roll back to checkpoint" in the UI, and pruning of old checkpoint/failed branches.
2. Unattended-loop safety: per-agent timeout, budget cap (`claude --max-budget-usd`), stuck detection, retry policy.
3. Read-only architect and QA (deny Edit/Write through the `--settings` file).
4. Show cost/token usage per run (same data as the budget cap).
5. Show which queue goal is currently running; graceful "stop after current goal".
See `TODO.md` and `IMPROVEMENTS.md` for the full lists.
