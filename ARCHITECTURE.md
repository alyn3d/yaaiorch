# YAAIORCH architecture

## Overview

YAAIORCH (Yet Another AI Orchestrator) turns a goal into working code by looping specialist agents until QA passes.

    goal ──► architect ──► foundation ──► build (parallel) ──► verify (QA)
                ▲                                                   │
                └──────────── QA failures (next round) ◄────────────┘

Three layers:

| Layer | Path | Role |
|---|---|---|
| YAAIORCH CLI | `orch.ts` | The loop. Spawns `claude` per agent, validates plans, checks diffs, keeps the queue. |
| Agents | `orch-agents.ts` | Built-in `architect` (read-only planner), `fe`, `be` (implementers), `qa` (verifier). Agents in `~/.claude/agents` or the target repo's `.claude/agents` are discovered automatically and override built-ins of the same name. |
| UI | `orch-ui/` | React + TS + SCSS. Runs in a browser (Node server) or as a Tauri v2 desktop app. |

`orch.ts` and `orch-ui/` must sit side by side. The UI looks for `../orch.ts`.

## Orchestrator (`orch.ts`)

### CLI

    orch run "<goal>"     one goal, loop until QA passes or max rounds
    orch add "<goal>"     append to the queue
    orch loop             process the queue (--until-empty to stop when drained)
    orch status           print the queue
    orch agents           list discovered agents and skills

Options: `--max-rounds N` (5), `--power max|heavy|balanced|economy` (heavy), `--poll S` (15), `--until-empty`, `--dry-run`. It runs in the target repo (current working directory).

### Power tiers

Map each role to a model. The architect and QA get the strongest models; implementers get cheaper ones unless a task is flagged `heavy`.

| Tier | architect | implementer | heavy task | QA |
|---|---|---|---|---|
| max | opus | opus | opus | opus |
| heavy | opus | sonnet | opus | opus |
| balanced | sonnet | sonnet | opus | opus |
| economy | sonnet | haiku | sonnet | sonnet |

### Round lifecycle (`runGoal`)

1. **Checkpoint** (skipped for `--dry-run`). If the target is a git repo: refuse a dirty tree or a repo with no commits, then create branch `orchestrator/checkpoint-<ts>` and emit `checkpoint`. Without git there is no rollback, no commits and no phantom-completion check.
2. **Architect.** Gets the goal, the agent roster (minus itself), the skill list, the previous round's failures, and the plan reply format. Must answer with one JSON `Plan`. A reply that is not valid JSON or fails validation is sent back once with the reason.
3. **Validate.** Rejects a malformed plan, unknown agents, invalid phases, foundation/build tasks without files, a file owned by two tasks (paths normalized: `./`, `\`, case on Windows), and plans with no `verify` task.
4. **Foundation** tasks run one at a time (shared types, tokens, API client). If one errors, the rest of the round is skipped (`SKIPPED`).
5. **Build** tasks run in parallel. File ownership is what makes this safe. A task that errors does not stop its siblings; its error becomes a round failure.
6. **Commit.** All changes except `.orchestrator/` are committed on the current branch (`orch: <goal> (round N)`). If the commit fails (for example a hook), the round continues uncommitted.
7. **Checks.** The orchestrator runs the repo's check commands itself (10 min timeout each) and emits `checks`. Commands come from `.orchestrator/config.json` `checks`, else from the package.json scripts `typecheck`, `lint`, `test`, `build` (npm's placeholder test is skipped).
8. **Verify** tasks run sequentially, never edit. Each returns `{passed, failures[]}`. They receive the implementer reports, the diff stat against the checkpoint, any uncommitted new files, and the check results with output tails. A verify call that errors counts as a failure.
9. Write `.orchestrator/last-run.json`. The round passes only if no task errored, every check exited 0, and every verdict passed. A failed check is a failure whatever QA says. Otherwise feed the failures to the next architect round.
10. **Finish** (git only). On pass, delete the checkpoint. On failure in `loop`, move the goal's commits to `orchestrator/failed-<ts>` and reset the branch to the checkpoint, so the next goal starts clean. On failure in `run`, leave the commits and print the rollback command.

### Plan shape

    Plan = { summary, tasks: Task[] }
    Task = { agent, phase: "foundation"|"build"|"verify", task, files?: string[],
             heavy?: boolean, figma?: string, skills?: string[] }

### Trust model: diff over report

Agent reports are not trusted. `execute()` hashes each owned file (`git hash-object`) before and after. If an agent says `Status: COMPLETE` but no owned file changed, that is a phantom completion: it is re-dispatched once, then recorded as `PHANTOM`.

### Running agents (`run()`)

Each agent is a one-shot headless call:

    claude -p [--agents .orchestrator/builtin-agents.json] --settings .orchestrator/agent-settings.json --agent <name> --model <m> --output-format json --permission-mode acceptEdits

`--agents` is added for built-in agents. In `-p` mode with `acceptEdits`, every shell command is refused unless allowed (confirmed in a real run), so `agent-settings.json` allows the check commands (`Bash(...)` and `PowerShell(...)`), `npm test` and read-only git, plus anything in `.orchestrator/config.json` `allow`. Compound commands (`cd x && npm test; echo $?`) still do not match those rules, which is why the orchestrator runs the checks itself rather than relying on QA. The prompt goes through stdin (no quoting problems on Windows). A reply with `is_error` or without a string `result` is an error. `extractJson` prefers a fenced `json` block, then the outermost `{...}`. On Windows the process is spawned through a shell with `windowsHide`.

### Reply contracts

`orch.ts` appends the required reply format to every prompt, so discovered agents follow it too: the architect returns a JSON `Plan`, implementers end with `Status: COMPLETE|PARTIAL|FAILED`, verifiers return JSON `{passed, failures[]}`.

### Queue and loop

`.orchestrator/queue.json` holds `{id, goal, status: pending|running|done|failed}`. On start, `loop` resets items left `running` by a crash or Stop to `pending`. It picks the first pending item, runs it, then re-reads the queue before writing the result, so goals added meanwhile are kept. SIGINT finishes the current goal and exits. `loop` refuses `--dry-run`, since a planned-only goal would stay pending forever.

### Structured events

With `ORCH_EVENTS` set, `orch.ts` also prints one `@@ORCH@@ {json}` line per event (all carry `type` and `t` in ms):

| type | fields |
|---|---|
| `goal_start` | goal, maxRounds, dryRun |
| `queue_item` | id, goal (loop only) |
| `checkpoint` | branch (git only, not on dry run) |
| `round_start`, `architect_start` | round |
| `plan` | round, summary, tasks[] (each with `id`) |
| `checks` | round, results[] ({name, command, ok, code, ms}) |
| `task_start` | round, id, agent, phase |
| `task_end` | round, id, agent, phase, status, touched[], failures?, error? |
| `round_end` | round, passed, failures[] |
| `goal_end` | passed, error? |

Task `status` is `COMPLETE`, `PARTIAL`, `FAILED`, `PHANTOM`, `UNKNOWN`, `ERROR`, `SKIPPED` (implementers), `PASS`/`FAIL`/`ERROR`/`SKIPPED` (QA). The UI adds `STOPPED` for tasks unfinished when the process exits without `goal_end`. Plain log lines are unchanged, so CLI use is unaffected.

## UI (`orch-ui/`)

### Frontend (`src/`)

| File | Role |
|---|---|
| `transport.ts` | The only place that knows how to reach the backend. Browser: `fetch` + `EventSource`. Desktop: Tauri `invoke` + `listen`. Chosen at startup via `__TAURI_INTERNALS__`. |
| `useOrch.ts` | Hook: `state`, `log`, `run`, `error`, `call()`, `pickRepo()`. |
| `reduce.ts` | Pure fold of `OrchEvent`s into a `RunView` (rounds → tasks). A reload replays the stored events through it. |
| `RunView.tsx` | Task cards grouped Foundation / Build / Verify, with status, elapsed time, owned and changed files, failures. |
| `App.tsx`, `App.scss` | Goal form, queue, run panel, live log. |
| `types.ts` | Shared types. |

State flow: backend pushes `init` (full snapshot: state + log + events), then `state`, `log`, `ev` deltas.

### Backend A: browser mode (`server.ts`)

Node `http` server on `127.0.0.1:4317`. Spawns `orch.ts` through tsx in `ORCH_REPO`.

| Route | Purpose |
|---|---|
| `GET /api/events` | SSE: `init`, `state`, `log`, `ev` |
| `GET /api/state`, `/api/agents` | Snapshot, roster |
| `POST /api/run`, `/add`, `/loop`, `/stop`, `/clear-log` | Actions |
| static | serves `dist/` |

### Backend B: desktop mode (`src-tauri/src/main.rs`)

Tauri v2. Replaces the Node server. Runs the compiled `orch.mjs` with `node` in the chosen repo.

| Command | Purpose |
|---|---|
| `snapshot` | Full init payload |
| `set_repo(path)` | Validate folder, persist to `<app config>/repo.txt`, emit `orch-init` |
| `run_goal`, `run_loop`, `add_goal`, `stop`, `clear_log`, `agents` | Same actions as the HTTP API |

Events to the UI: `orch-init`, `orch-state`, `orch-log`, `orch-ev`.

Internals: one `Mutex<Inner>` holds repo, running process, log ring (5000 lines) and the events of the current goal (cleared on `goal_start`). Two reader threads per child feed `push_line`, which splits structured lines from plain ones. A wait thread joins the readers before reporting exit, so the last output is never lost. Stop uses `taskkill /T /F` on Windows and a process-group `kill` elsewhere; the app also does this on exit. `orch.mjs` is built from `../orch.ts` by esbuild into `src-tauri/resources/` and bundled as a resource. Lookup order: `ORCH_PATH`, bundled resource, dev manifest path.

## Data on disk

| Path | Owner | Content |
|---|---|---|
| `<target>/.orchestrator/queue.json` | orch.ts / UI | Queue |
| `<target>/.orchestrator/last-run.json` | orch.ts | Rounds of the latest goal |
| `<target>/.orchestrator/builtin-agents.json` | orch.ts | Built-in agent definitions passed to `claude --agents` |
| `<target>/.orchestrator/agent-settings.json` | orch.ts | Permission allow-list passed to `claude --settings` |
| `<target>/.orchestrator/config.json` | user | Optional: `{"checks": {"name": "command"}, "allow": ["Bash(...)"]}` |
| `<target>` git branches `orchestrator/checkpoint-*` | orch.ts | Rollback point of the running or last unfinished goal |
| `<target>` git branches `orchestrator/failed-*` | orch.ts | Work of goals that failed in `loop` |
| `<app config>/repo.txt` | Tauri | Last chosen repo |

Run events and the log live in memory only and are lost on restart.

## Design decisions

- **Headless CLI per agent, not an SDK session.** One process per agent keeps isolation simple and reuses the user's Claude Code login, agents and skills. Cost: no streaming from inside an agent, and no shared context between agents (tasks must be self-contained).
- **Exclusive file ownership.** The architect assigns each file to one task. That is what makes parallel build safe in a single working tree.
- **Structured events on stdout.** One protocol serves both backends. Adding a UI never requires touching the loop.
- **Same UI, two transports.** `transport.ts` is the seam; the web build stays usable without Rust.
- **Node required at runtime.** The orchestrator is bundled as JS, not as a native binary.

## Testing

- Rust: `cargo test` in `src-tauri` spawns the real `orch.mjs` with a fake `claude` and asserts the event sequence, double-run refusal and clean exit. It is skipped unless `TEST_REPO`, `ORCH_PATH`, `CLAUDE_BIN` are set.
- Frontend: `npm run build` runs `tsc`. There are no unit tests yet.
