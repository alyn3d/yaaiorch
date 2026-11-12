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
    orch doctor [--json]  first-run checks: node, claude installed and logged in, git, clean repo, leftover checkpoints, checks
    orch rollback [BRANCH]  reset to the latest (or given) checkpoint; discarded work kept on orchestrator/discarded-*
    orch prune [--older-than DAYS]  delete orchestrator/* branches older than DAYS (14)

Options: `--max-rounds N` (5), `--power max|heavy|balanced|economy` (heavy), `--max-cost USD` (per goal, none by default), `--agent-timeout MIN` (30), `--poll S` (15), `--until-empty`, `--dry-run`. It runs in the target repo (current working directory). Errors print one line; set `ORCH_DEBUG=1` for stack traces.

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
10. **Stuck detection.** A failed round that changed no files, or ended with the same failures as the round before (compared ignoring case, spacing and numbers), counts as stuck. The first time, the next round runs one power tier up (economy → balanced → heavy → max) and the architect is told not to repeat its plan (emits `stuck` with action `escalate`, or `retry` at max). Two stuck rounds in a row stop the goal (`stuck`, action `stop`).
11. **Finish** (git only). On pass, delete the checkpoint. On failure in `loop`, move the goal's commits to `orchestrator/failed-<ts>` and reset the branch to the checkpoint, so the next goal starts clean. On failure in `run`, leave the commits; `orch rollback` (or the UI button) undoes them.

### Fast path (`--fast`, experimental)

Round 1 skips the architect: one generalist `dev` agent does the whole goal on the tier's heavy model, with no file list (so no phantom check). The repo's checks judge it; when no checks are configured a QA task is added. `round_start` carries `mode: "direct"`. If the round fails, later rounds run the normal loop with its failures. The evals compare it with `--power economy+fast` against the full loop and `--single`.

### Limits

- **Agent timeout** (`--agent-timeout`, 30 min): a call that runs longer is killed with its whole process tree (`taskkill /T` on Windows) and becomes a task error.
- **Budget** (`--max-cost`): every call's `total_cost_usd` is added to the goal's total, also for failed calls. Each call gets `--max-budget-usd` set to what is left (at least $0.01). When the CLI reports `error_max_budget_usd`, or the total reaches the cap before a call, the goal stops with `Stopped: budget of $X used up`. The CLI checks its limit after each turn, and parallel calls each get the full remainder, so a goal can overshoot the cap by up to one turn per parallel call.

- **Usage limit**: the Claude subscription limit comes back as an error result with subtype `success` and text like `You've hit your 5-hour limit · resets 1:30am (Europe/London)`. `run()` turns it into a `UsageLimit` error (reset time parsed in the named IANA zone) that ends the goal instead of becoming a task failure, so it never triggers stuck detection. It emits `usage_limit`, then `goal_end` with `usageLimit: true, resetAt`. What happens next is the **"when the usage limit is hit"** setting (`--on-limit`, config `onLimit`):
  - `wait` (default): the goal's work moves to `orchestrator/interrupted-*` and the branch is reset to the checkpoint; orch waits until a minute after the reset (30 min if the reply has no time; `ORCH_LIMIT_WAIT_MS` overrides it for tests), emits `waiting`, and retries the goal. In `loop` the item goes back to `pending` with a `note` meanwhile.
  - `stop`: `orch run` exits with **code 3** (commits kept, `orch rollback` available). In `loop` the work is set aside, the item stays `pending` with a "stopped" `note`, and orch exits 3.

### Models

Each power tier maps the roles `architect`, `impl`, `heavy`, `qa` and `dev` (the fast path's agent, the tier's heavy model by default) to models. `--model architect=opus,impl=haiku,be=claude-…` and `.orchestrator/config.json` `"models": { "architect": …, "agents": { "be": … } }` override them: a per-agent override beats a per-role override, and the CLI beats the config. An override for an agent that does not exist fails the goal. When a stuck round moves up a tier, alias overrides (`haiku` → `sonnet` → `opus`) move up with it; full model IDs stay as set. Each `round_start` carries the effective `models`.

### Rollback and pruning

`orch rollback` picks the newest `orchestrator/checkpoint-*` (or the given branch), refuses if it is not an ancestor of the current branch, commits whatever is left (including uncommitted edits from a stopped run), keeps that on `orchestrator/discarded-<ts>`, resets to the checkpoint, deletes the checkpoint and clears it from `last-run.json`. Nothing is lost. `orch prune` deletes `orchestrator/*` branches whose timestamp is older than `--older-than` days, never the current branch.

### Plan shape

    Plan = { summary, tasks: Task[] }
    Task = { agent, phase: "foundation"|"build"|"verify", task, files?: string[],
             heavy?: boolean, figma?: string, skills?: string[] }

### Trust model: diff over report

Agent reports are not trusted. `execute()` hashes each owned file (`git hash-object`) before and after. If an agent says `Status: COMPLETE` but no owned file changed, that is a phantom completion: it is re-dispatched once, then recorded as `PHANTOM`.

### Running agents (`run()`)

Each agent is a one-shot headless call:

    claude -p [--agents .orchestrator/builtin-agents.json] --settings <settings> --agent <name> --model <m>
              --output-format json --permission-mode <mode> [--max-budget-usd <left>]

`--agents` is added for built-in agents. Implementers run with `acceptEdits` and `agent-settings.json`. The architect and verifiers are read-only: permission mode `default` with `readonly-settings.json`, which adds a deny on Edit/Write/MultiEdit/NotebookEdit. Denying the edit tools alone is not enough: under `acceptEdits` an agent wrote a file with a shell redirect instead (confirmed with the real CLI), while `default` refuses that and still runs allow-listed commands. In `-p` mode with `acceptEdits`, every shell command is refused unless allowed (confirmed in a real run), so `agent-settings.json` allows the check commands (`Bash(...)` and `PowerShell(...)`), `npm test` and read-only git, plus anything in `.orchestrator/config.json` `allow`. Compound commands (`cd x && npm test; echo $?`) still do not match those rules, which is why the orchestrator runs the checks itself rather than relying on QA. The prompt goes through stdin (no quoting problems on Windows). The JSON reply is parsed even on a non-zero exit, so the cost and the reason (`subtype`) are kept. A reply with `is_error`, a non-zero exit or no string `result` is an error. `extractJson` prefers a fenced `json` block, then the outermost `{...}`. On Windows the process is spawned through a shell with `windowsHide`.

### Reply contracts

`orch.ts` appends the required reply format to every prompt, so discovered agents follow it too: the architect returns a JSON `Plan`, implementers end with `Status: COMPLETE|PARTIAL|FAILED`, verifiers return JSON `{passed, failures[]}`.

### Queue and loop

`.orchestrator/queue.json` holds `{id, goal, status: pending|running|done|failed, note?}` (`note` explains a wait, shown in the UI queue). On start, `loop` resets items left `running` by a crash or Stop to `pending`. It picks the first pending item, runs it, then re-reads the queue before writing the result, so goals added meanwhile are kept. SIGINT finishes the current goal and exits. `loop` refuses `--dry-run`, since a planned-only goal would stay pending forever.

### Structured events

With `ORCH_EVENTS` set, `orch.ts` also prints one `@@ORCH@@ {json}` line per event (all carry `type` and `t` in ms):

| type | fields |
|---|---|
| `goal_start` | goal, maxRounds, dryRun, power, maxCost?, models ({roles, agents} overrides), onLimit |
| `queue_item` | id, goal (loop only) |
| `checkpoint` | branch (git only, not on dry run) |
| `round_start` | round, power, models (effective model per role), mode? (`direct` on the fast path) |
| `architect_start` | round |
| `plan` | round, summary, cost, tasks[] (each with `id`) |
| `checks` | round, results[] ({name, command, ok, code, ms}) |
| `task_start` | round, id, agent, phase |
| `task_end` | round, id, agent, phase, status, touched[], cost?, failures?, error? |
| `round_end` | round, passed, failures[], cost |
| `stuck` | round, action (`escalate`/`retry`/`stop`), reason, power? |
| `usage_limit` | message, resetAt? (epoch ms) |
| `goal_end` | passed, cost, error?, usageLimit?, resetAt? |
| `waiting` | reason (`usage_limit`), until (loop only, between goals) |

Costs are USD from the CLI's `total_cost_usd`, rounded to 4 decimals.

Task `status` is `COMPLETE`, `PARTIAL`, `FAILED`, `PHANTOM`, `UNKNOWN`, `ERROR`, `SKIPPED` (implementers), `PASS`/`FAIL`/`ERROR`/`SKIPPED` (QA). The UI adds `STOPPED` for tasks unfinished when the process exits without `goal_end`. Plain log lines are unchanged, so CLI use is unaffected.

## UI (`orch-ui/`)

The UI works on several repos at once: one **tab per repo**, each with its own goal form, settings,
queue, run panel and log. Each repo has a **session** in the backend: its own `orch` process, log and
events. One run per repo at a time (agents share that repo's working tree); at most `maxParallel`
repos run at once (default 2, 1-16) and further starts wait for a free slot, oldest first. All repos
share one Claude usage limit, so the limit is the main brake on parallel runs.

Two things are shared by all repos and kept by the backend (the **global** state):

- **Usage-limit hold.** When any repo reports the usage limit (`usage_limit`, or `waiting` with `until`),
  new starts in every repo wait until the latest reset time. Running goals are not stopped; each waits
  on its own (`--on-limit`). The UI shows one banner with **Try now**, which lifts the hold early.
- **Daily budget** (optional, USD, local day). The backend adds up `cost` from every `plan` and
  `task_end` event in every repo; the total is stored, so it survives a restart the same day. Each new
  run gets `--max-cost` capped to what is left (its own `--max-cost` if lower). When it is used up, new
  starts wait for the next day (or a higher budget), and a running loop is stopped at its next
  `queue_item`. Runs that start together each get the whole remainder, so the total can overshoot by
  up to what one run spends.

A start that waits is `queued` with a `waitReason`: the usage limit, the budget, or a free slot.

### Frontend (`src/`)

| File | Role |
|---|---|
| `transport.ts` | The only place that knows how to reach the backend. Browser: `fetch` + `EventSource`. Desktop: Tauri `invoke` + `listen`. Chosen at startup via `__TAURI_INTERNALS__`. Every message carries its `repo`. |
| `useOrch.ts` | `useOrch()`: sessions keyed by repo (state, log, run view), tab order, `maxParallel`, `global` (usage-limit hold, daily budget). `useFindings(repo, busy)`: doctor per repo, refreshed when its process ends. |
| `App.tsx` | Header (running count, Parallel limit, Daily $ budget and today's spend), usage-limit and budget banners, tab bar with a status dot per repo (running, waiting for a slot or the usage limit, failed, done, idle), add/close repo. All tabs stay mounted, so a hidden tab keeps its form and keeps updating. |
| `Overview.tsx` | The **Overview** tab (shown from two repos on): one row per repo with its phase (planning, building, verifying, checks, waiting), goal, round, tasks done and running agents, cost against its cap, pending queue, and Open / Stop. |
| `repoStatus.ts` | `repoStatus()`: a repo's status dot and label, shared by the tabs and the overview. |
| `RepoView.tsx` | One repo: goal form, settings, doctor banner, rollback offer, queue, run panel, live log. |
| `Settings.tsx` | Usage-limit choice, fast path, models per role and agent; remembered per repo in local storage. |
| `reduce.ts` | Pure fold of `OrchEvent`s into a `RunView` (rounds -> tasks). A reload replays the stored events through it. |
| `RunView.tsx` | Task cards grouped Foundation / Build / Verify, with status, elapsed time, owned and changed files, failures. |
| `types.ts` | Shared types. |

State flow: the backend pushes `init` (`{ sessions: [{ state, log, events }], maxParallel, global }`, also
after a repo is added or removed or the limit changes), then per-repo deltas: `session` (one repo's state),
`log` (`{ repo, line }`) and `ev` (`{ repo, ev }`), and `global`
(`{ usageLimit: { repo, until } | null, budget: { limit, spent, day } }`) when the hold or the spending
changes. A repo's state includes `queued` and `waitReason` while its start waits.

### Backend A: browser mode (`server.ts`)

Node `http` server on `127.0.0.1:4317`. Spawns `orch.ts` through tsx in each repo. Opens the repos
remembered in `~/.yaaiorch/ui.json` plus `ORCH_REPO` / `ORCH_REPOS` (separated by the OS path delimiter);
`MAX_PARALLEL` sets the limit.

| Route | Purpose |
|---|---|
| `GET /api/events` | SSE: `init`, `session`, `log`, `ev`, `global` |
| `GET /api/state` | The init payload |
| `GET /api/doctor?repo=`, `/api/agents?repo=` | `orch doctor --json`, roster |
| `POST /api/add-repo` `{ path }`, `/api/remove-repo` `{ repo }` | Open or close a repo (closing is refused while it runs) |
| `POST /api/settings` `{ maxParallel?, dailyBudget? }` | Change the parallel limit and/or the daily budget (`null` or `""` = none) |
| `POST /api/clear-limit` | Lift the usage-limit hold ("Try now") |
| `POST /api/run`, `/add`, `/loop`, `/stop`, `/clear-log`, `/rollback` | Actions on `{ repo, … }`; `stop` also cancels a start waiting for a slot |
| static | serves `dist/` |

### Backend B: desktop mode (`src-tauri/src/main.rs`)

Tauri v2. Replaces the Node server. Runs the compiled `orch.mjs` with `node` in each repo.

| Command | Purpose |
|---|---|
| `snapshot` | The init payload |
| `add_repo(path)`, `remove_repo(repo)`, `set_max_parallel(maxParallel)` | Open or close a repo, change the limit; persisted to `<app config>/repos.json` (the old single `repo.txt` is migrated) |
| `set_daily_budget(dailyBudget)`, `clear_limit` | Daily budget (`null` = none), lift the usage-limit hold |
| `run_goal`, `run_loop`, `add_goal`, `stop`, `clear_log`, `agents`, `rollback` | Same actions as the HTTP API, each with `repo` |
| `doctor(repo)` | `orch doctor --json` (async command, so starting node does not freeze the window) |

Events to the UI: `orch-init`, `orch-session`, `orch-log`, `orch-ev` (these two as `{ repo, … }`), `orch-global`.

Internals: one `Mutex<Inner>` holds the sessions (repo, running process, pending start, log ring of 5000
lines, events of the current goal), the start queue, `max_parallel` and the global hold and budget.
A ticker thread (30 s) lifts an expired hold, starts a new budget day and starts what waits. Two reader threads per child
feed `push_line`, which splits structured lines from plain ones. A wait thread joins the readers before
reporting exit, so the last output is never lost, then starts the next queued repo. Stop uses
`taskkill /T /F` on Windows and a process-group `kill` elsewhere; the app does this for every running
repo on exit. `orch.mjs` is built from `../orch.ts` by esbuild into `src-tauri/resources/` and bundled as
a resource. Lookup order: `ORCH_PATH`, bundled resource, dev manifest path.

## Data on disk

| Path | Owner | Content |
|---|---|---|
| `<target>/.orchestrator/queue.json` | orch.ts / UI | Queue |
| `<target>/.orchestrator/last-run.json` | orch.ts | Latest goal: status, total cost, `checkpoint` (only while that branch exists; drives the UI's rollback offer), and per round power, plan, touched files, checks, failures, cost |
| `<target>/.orchestrator/readonly-settings.json` | orch.ts | Allow-list plus edit-tool deny for the architect and verifiers |
| `<target>` git branches `orchestrator/discarded-*` | orch.ts | Work thrown away by `orch rollback` |
| `<target>/.orchestrator/builtin-agents.json` | orch.ts | Built-in agent definitions passed to `claude --agents` |
| `<target>/.orchestrator/agent-settings.json` | orch.ts | Permission allow-list passed to `claude --settings` |
| `<target>/.orchestrator/config.json` | user | Optional: `{"checks": {"name": "command"}, "allow": ["Bash(...)"]}` |
| `<target>` git branches `orchestrator/checkpoint-*` | orch.ts | Rollback point of the running or last unfinished goal |
| `<target>` git branches `orchestrator/failed-*` | orch.ts | Work of goals that failed in `loop` |
| `<app config>/repos.json` | Tauri | Open repos, the parallel limit, the daily budget and today's spending |
| `~/.yaaiorch/ui.json` | server.ts | Same, for browser mode |

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
