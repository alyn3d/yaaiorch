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
| Claude launcher | `claude-bin.ts` | Finds the `claude` executable once. On Windows an `.exe` runs directly and an npm `.cmd` shim is unwrapped to node + its script, so no cmd.exe sits between orch and claude (fallback: cmd.exe for a shim it cannot read). PATH only, never the current directory. |
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
2. **Architect.** Gets the goal, the agent roster (minus itself), the skill list, the project brief, and from round 2 on what the previous round did (its plan, how each task ended, and the diff stat since the checkpoint) plus its failures, and the plan reply format. Must answer with one JSON `Plan`. **Project brief:** `.orchestrator/brief.md` holds the architect's notes on the repo (stack, layout, conventions, commands). With none, the architect is asked for a `brief` field and orch writes it; later rounds and goals get it in the prompt, and so do every implementer and QA call (with the last 1500 characters of the notes, as `ctx.repoContext`) and the fast path's `dev` agent, so they need not re-read the repo. The architect returns `brief` again only to correct it. The file's first line stamps the commit it describes; when 20 or more files (outside `.orchestrator/`) changed since, or the commit is gone, the first round of the next goal asks the architect to check it, and re-stamps it if nothing needed correcting. `orch learn` (the UI's **Learn repo**) writes or corrects the brief up front in one read-only architect call, with the goal's power, models, budget, usage caps and plugin choice; it emits `learn_start` and `learn_end` (ok, cost), and the backends count that cost toward the daily budget. `--no-brief` (config `"brief": false`) turns this off; delete the file to start over. **Notes:** `.orchestrator/notes.md` collects lessons from earlier goals (QA's optional `notes`, the round-1 failures of a goal that needed several rounds, and what a failed goal left unresolved), newest last, oldest dropped past 8000 characters; past 5000 characters, one read-only call on the implementers' model merges duplicates and drops lessons that no longer apply (`tidyNotes`, event `notes_tidy`, part of the goal's cost; a bad reply keeps the file); the architect (and the fast path's agent) get its last 4000 characters. `--no-notes` / `"notes": false`.
2b. **Plan critic** (`--critic`, config `"critic": true`, off by default). The built-in read-only `critic` agent (never given tasks) reviews the plan with only the goal, the brief and the plan, never the architect's reasoning, and answers `{approved, issues[]}` on QA's model. A rejection goes back to the architect once with the issues; the revised plan is not reviewed again. A critic error that is not a budget or usage limit just approves. Emits `critic`; its cost is part of the plan's. A reply that is not valid JSON or fails validation is sent back once with the reason.
2b'. **Plan approval** (`--approve-plan`, config `"approvePlan": true`; not on the fast path's direct round or a dry run). After the critic, orch writes `.orchestrator/plan-pending.json` ({goal, round, plan}), emits `approval_wait` (round, summary, tasks, error?) and polls for `.orchestrator/plan-decision.json`, without a time limit. `orch approve` writes that answer: approve, approve with an edited plan (`--plan-stdin`, validated against the agents before it is written, and again by the run, which waits again with `error` if it is still invalid), or `--reject "why"`, which goes to the architect as a note; the new plan waits again. Each answer emits `approval` (round, action, edited). The backends call `orch approve` and pass an edited plan on stdin.
2f. **Big briefs** (`orch split`; also used by `orch new`). `splitBrief` makes one read-only architect call with the brief (up to 100,000 characters) and, for an existing repo, the instruction to read it first; the reply is at most 30 goals in build order, each starting with the part of the brief it covers, plus checks for a new project. It emits `split_proposal` (goals, checks?, cost). `--propose` stops there (the UI shows the list to edit); `orch split --accept` takes `{brief, goals}` on stdin. Accepting writes `.orchestrator/spec.md` and queues the goals with `fromSpec: true`. `makePlan` puts the first 15,000 characters of spec.md in every architect prompt. **Coverage:** when `loop` finds no pending goal, and goals from the brief have finished since the last check (`.orchestrator/spec-state.json`), one read-only call compares the brief with the code and the goals run, and queues at most 5 missing goals (event `coverage`: pass, missing, cost); at most two passes per brief, `--no-coverage` / `"coverage": false`. The backends pass a brief to `orch split --propose` in a temporary file that orch deletes (`--brief-file-temp`) and count both events' cost.
2e. **New project** (`orch new DIR "<spec>"`, `--spec-file`, `--setup CMD`; not part of a run). Refuses a folder that is not empty. Creates it, `git init` on `main`, commits `SPEC.md` and a `.gitignore` (`.orchestrator/`, dependency and build folders), seeds the brief with the spec, then one read-only architect call returns `{goals[], checks{}}`: at most 12 goals (the first sets the project up) are queued, and at most 4 valid checks plus `setup` go into `.orchestrator/config.json`. It builds nothing; the user reviews and runs `orch loop`.
2c. **Share** (`orch share`, the UI's **Share to CLAUDE.md**; not part of a run). One read-only architect call turns the brief, the notes and the current `CLAUDE.md` into the body of a section between `<!-- yaaiorch:learned:start -->` and `<!-- yaaiorch:learned:end -->` (replacing an earlier one; everything else in the file is kept). orch commits it with git plumbing (a temporary index, `commit-tree`) on a new `orchestrator/claude-md-<ms>` branch off HEAD, so neither the working tree nor the index changes; the user reviews and merges it. `--dry-run` prints the section. Takes the run lock; the backends count its cost.
2d. **Branch per goal** (`--branch`, config `"branch": true`; `--pr` implies it). After the checkpoint, orch switches to a new branch `orch/<queue id or time stamp>-<slug of the goal>` (event `goal_branch`, with the base branch; a detached HEAD is refused). Every round commits there. At the end, whatever the outcome, orch commits what is left, switches back to the base branch (which never moved) and deletes the checkpoint; a goal branch without commits is deleted, any other stays. If the work cannot be committed, orch stays on the goal branch and keeps the checkpoint. In a loop each goal branches from the base, not from the goal before. With `--pr` (config `"pr": true`), a passed goal's branch is pushed to `origin` (`GIT_TERMINAL_PROMPT=0`, so a credential prompt cannot hang a run) and `gh pr create --base <base> --head <branch> --title <goal> --body-file -` opens the pull request, its body (the goal, each round's plan, checks and cost) on stdin. `gh` is found like `claude` (`GH_BIN` overrides; no shell on Windows). A missing remote, a missing or failing `gh` is reported in the `pr` event (`url` or `error`) and never fails the goal. `last-run.json` records `branch`, `base` and `pr`.
3. **Validate.** Rejects a malformed plan, unknown agents, invalid phases, foundation/build tasks without files, a file owned by two tasks (paths normalized: `./`, `\`, case on Windows), and plans with no `verify` task. Plans are untrusted input: every file path must be relative to the repo root (no absolute, drive or UNC path, no `..`), must not be in `.git/` or `.orchestrator/`, and must not resolve outside the repo through a symlink or junction (checked on the deepest existing part); at most 25 tasks and 60 files per task. The error names the task and the file.
4. **Foundation** tasks run one at a time (shared types, tokens, API client). If one errors, the rest of the round is skipped (`SKIPPED`).
5. **Build** tasks run in parallel. File ownership is what makes this safe. A task that errors does not stop its siblings; its error becomes a round failure. **Ownership check:** afterwards, files changed outside every task's list (git status against the files changed before the round) are logged and sent as `unowned`; QA gets the list with the diff, and with `--strict-files` (config `strictFiles`) they fail the round. Plans without file lists (the fast path) are exempt.
6. **Commit.** All changes except `.orchestrator/` are committed on the current branch (`orch: <goal> (round N)`); with `--branch` that is the goal's own branch. If the commit fails (for example a hook), the round continues uncommitted.
7. **Checks.** First, if the config has `setup` (for example `npm install`) and a watched manifest or lock file (`setupWhen`, default package.json, lock files, requirements.txt, pyproject.toml, go.mod, Cargo.toml, ...) changed since it last succeeded (`.orchestrator/setup-state.json`), orch runs it (a check named `setup`; if it fails, no other check runs and the round fails). Untracked directories it creates that git does not ignore go into `.git/info/exclude`. The checks are read again here and at each round start, so a package.json the agents just wrote counts. Implementers are told to add dependencies to the manifest, never to install them. The orchestrator runs the repo's check commands itself (10 min timeout each) and emits `checks`. Commands come from `.orchestrator/config.json` `checks`, else from the package.json scripts `typecheck`, `lint`, `test`, `build` (npm's placeholder test is skipped).
8. **Diff reviews** (off by default), started next to the verify tasks when no task errored and every check passed (a failed check wins, so nothing is spent on reviews then): `--diff-critic` (config `diffCritic`) has the `critic` read the change against the goal (lens `goal`); `--review` (config `"review": true`) has the built-in read-only `reviewer` read it for bugs and security (lens `bugs`), or your own agents with `--reviewers A,B` (config `"review": ["A", "B"]`; unknown names are refused). Each gets the goal, the brief and notes, the diff stat and the patch since the checkpoint (first 30,000 characters), answers `{approved, issues[]}` on QA's model, and emits `review`. A rejection's issues become round failures (`<agent> (review): ...`); an error that is not a budget or usage limit approves. Reviewers and the critic are never given tasks.
9. **Verify** tasks run sequentially, never edit. Each returns `{passed, failures[]}`. They receive the implementer reports, the diff stat against the checkpoint, any uncommitted new files, and the check results with output tails. A verify call that errors counts as a failure.
10. Write `.orchestrator/last-run.json`. The round passes only if no task errored, every check exited 0, every verdict passed and every diff review approved. A failed check is a failure whatever QA says. Otherwise feed the failures to the next architect round.
11. **Stuck detection.** A failed round that changed no files, or ended with the same failures as the round before (compared ignoring case, spacing and numbers), counts as stuck. The first time the architect is told not to repeat its plan, and something moves one power tier up (economy → balanced → heavy → max): if some implementer tasks failed outright (FAILED, PARTIAL, PHANTOM, ERROR, UNKNOWN) while others completed, only those tasks' agents move up (their tier and alias overrides; `stuck` carries `agents`, `round_start` then `agentPower`); otherwise, when every task claims success and the plan or verification is the problem, the whole round moves up (`stuck` with action `escalate`, or `retry` at max). Two stuck rounds in a row stop the goal (`stuck`, action `stop`).
11. **Finish** (git only). On pass, delete the checkpoint. On failure in `loop`, move the goal's commits to `orchestrator/failed-<ts>` and reset the branch to the checkpoint, so the next goal starts clean. On failure in `run`, leave the commits; `orch rollback` (or the UI button) undoes them.

### Fast path (`--fast`, experimental)

Round 1 skips the architect: one generalist `dev` agent does the whole goal on the tier's heavy model, with no file list (so no phantom check). The repo's checks judge it; when no checks are configured a QA task is added. `round_start` carries `mode: "direct"`. If the round fails, later rounds run the normal loop with its failures. The evals compare it with `--power economy+fast` against the full loop and `--single`.

### Limits

- **Agent timeout** (`--agent-timeout`, 30 min): a call that runs longer is killed with its whole process tree (`taskkill /T` on Windows) and becomes a task error.
- **Session resume** (`--no-resume` or config `"resume": false` to turn off): every CLI reply carries a `session_id`.
  In a fix round, an implementer task continues the session of the same agent's task from the round before that
  shares a file with it (most shared files wins; with no file lists, only one task per agent then and now), with
  `--resume <id> --fork-session`, so parallel tasks and retries never share a session. Its prompt is the new task
  alone: the session already has the brief, the files it read and what it did. After a stuck round every task
  starts cold, so a failed approach is not carried on; QA and the architect never resume. If resuming fails (the
  session is gone), the task starts cold once. A phantom completion's retry continues its own session and is told
  which files did not change. `task_start` has `resumed: <round>` (a badge in the run panel).
- **Transient errors**: a call whose CLI error text shows an API overload, a 5xx or 429 API error, or a dropped
  connection (`TRANSIENT_RE`) is retried once after 15 s (`ORCH_RETRY_DELAY_MS`). Never the usage limit, the
  budget or an agent timeout, and never a task's own failure.
- **Loop budget** (`--max-cost-total`, config `maxCostTotal`, `loop` only): the goals of one loop run share it;
  each goal's `--max-cost` is capped to what is left, and the loop stops before its next goal (`loop_stop`,
  reason `budget`) once it is used up.
- **Budget** (`--max-cost`): every call's `total_cost_usd` is added to the goal's total, also for failed calls. Before it starts, each call reserves its share of the unreserved budget and gets it as `--max-budget-usd`: alone, all of it; in the parallel build batch, an equal share per task still to start (with $0.20 left, two build agents get $0.10 each). When the call ends its reservation is released and its real cost counted, also on failure, timeout or a spawn error. A call that would get less than $0.01 waits while others hold reservations, and otherwise stops the goal. When the CLI reports `error_max_budget_usd`, or the total reaches the cap, the goal stops with `Stopped: budget of $X used up`. The CLI checks its limit after each turn, so a call can overshoot its share by up to one turn.

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
              --output-format stream-json --verbose --permission-mode <mode> [--max-budget-usd <share>]

`--agents` is added for built-in agents. Implementers run with `acceptEdits` and `agent-settings.json`. The architect and verifiers are read-only: permission mode `default` with `readonly-settings.json`, which adds a deny on Edit/Write/MultiEdit/NotebookEdit. Denying the edit tools alone is not enough: under `acceptEdits` an agent wrote a file with a shell redirect instead (confirmed with the real CLI), while `default` refuses that and still runs allow-listed commands. In `-p` mode with `acceptEdits`, every shell command is refused unless allowed (confirmed in a real run), so `agent-settings.json` allows the check commands (`Bash(...)` and `PowerShell(...)`), `npm test` and read-only git, plus anything in `.orchestrator/config.json` `allow`. Compound commands (`cd x && npm test; echo $?`) still do not match those rules, which is why the orchestrator runs the checks itself rather than relying on QA. The prompt goes through stdin (no quoting problems on Windows). The JSON reply is parsed even on a non-zero exit, so the cost and the reason (`subtype`) are kept. A reply with `is_error`, a non-zero exit or no string `result` is an error. `extractJson` prefers a fenced `json` block, then the outermost `{...}`. The process is spawned without a shell (see `claude-bin.ts`), with `windowsHide`.

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
| `round_start` | round, power, models (effective model per role), mode? (`direct` on the fast path), agentPower? ({agent: power} for agents escalated on their own) |
| `architect_start` | round |
| `plan` | round, summary, cost, tasks[] (each with `id`) |
| `checks` | round, results[] ({name, command, ok, code, ms}) |
| `task_start` | round, id, agent, phase, resumed? (the round whose session it continues) |
| `task_end` | round, id, agent, phase, status, touched[], cost?, failures?, error? |
| `round_end` | round, passed, failures[], cost |
| `stuck` | round, action (`escalate`/`retry`/`stop`), reason, power?, agents? ({agent: power} when only the failing tasks' agents move up) |
| `critic` | round, approved, issues[], revised, cost |
| `loop_stop` | reason (`requested`, or `budget` with spent): the loop exits before its next goal |
| `unowned` | round, files[], strict: files changed outside every task's list |
| `learn_start`, `learn_end` | `orch learn`: power; then ok, cost |
| `split_proposal` | goals[], checks?, cost: a brief split into goals |
| `coverage` | pass, missing[], cost: the brief checked against the code |
| `approval_wait` | round, summary, tasks[], error?: `--approve-plan` waits for an answer |
| `approval` | round, action (`approve` or `reject`), edited |
| `goal_branch` | branch, base: `--branch` switched to the goal's branch |
| `pr` | branch, base, url? or error?: `--pr` after a passed goal |
| `review` | round, agent, lens (`goal` or `bugs`), approved, issues[], cost: a diff review |
| `notes_tidy` | ok, before, after (characters), cost |
| `share_start`, `share_end` | `orch share`: then ok, branch, cost |
| `usage_limit` | message, resetAt? (epoch ms) |
| `goal_end` | passed, cost, error?, usageLimit?, resetAt? |
| `waiting` | reason (`usage_limit` between goals, or `usage_cap` before an agent call, with `window`), until |
| `usage` | fiveHour?, week? (each {pct, resetsAt epoch ms}): the subscription's usage after an agent call |

The UI turns some live events into desktop notifications (`notifyText.ts`: goal_end, approval_wait, waiting, loop_stop with reason budget; replayed events never notify), through the Tauri notification plugin in the desktop app or the browser's Notification API, when **Notify** is on and the window is not focused.

Costs are USD from the CLI's `total_cost_usd`, rounded to 4 decimals. Agents run with `--output-format stream-json
--verbose`: orch takes the final `result` line, and reads the subscription's usage from the CLI's
`rate_limit_event` lines (`rate_limit_info.unifiedWindows.five_hour` / `seven_day`, `utilization` 0-1). That field is
not documented by the CLI; if it changes or is missing (API-key logins), there are no `usage` events and the caps do nothing.

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
- **Usage caps** (optional, percent of the 5-hour and weekly windows). The backend keeps the latest
  `usage` reading from any repo and passes the caps to every run as `--usage-cap 5h=N,week=M`. In orch,
  before each agent call a reading at or over a cap either pauses the goal in place until that window
  resets (`--on-limit wait`, event `waiting` with reason `usage_cap`) or ends it like a usage limit
  (`--on-limit stop`). The backend also holds new starts while a reading is over a cap; **Try now**
  forgets the readings. A call already running can go past a cap.

A start that waits is `queued` with a `waitReason`: the usage limit, the budget, a usage cap, or a free slot.

### Frontend (`src/`)

| File | Role |
|---|---|
| `transport.ts` | The only place that knows how to reach the backend. Browser: `fetch` + `EventSource`. Desktop: Tauri `invoke` + `listen`. Chosen at startup via `__TAURI_INTERNALS__`. Every message carries its `repo`. |
| `useOrch.ts` | `useOrch()`: sessions keyed by repo (state, log, run view), tab order, `maxParallel`, `global` (usage-limit hold, daily budget). `useFindings(repo, busy)`: doctor per repo, refreshed when its process ends. |
| `Plugins.tsx` | The **Plugins** section of a repo's run settings: the repo's Claude Code plugins (`orch plugins --json --details`, loaded when opened) with a switch each, one for all and one for hooks; remembered per repo with the other settings. |
| `Limits.tsx` | Header meters (5-hour and weekly usage, today's spend) and the Limits panel: Daily $, pause at 5h % and week %. |
| `App.tsx` | Header (running count, Parallel limit, Limits), usage-limit, usage-cap and budget banners, tab bar with a status dot per repo (running, waiting for a slot or the usage limit, failed, done, idle), add/close repo. All tabs stay mounted, so a hidden tab keeps its form and keeps updating. |
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

**Request guard** (`refuse()`): any web page in the user's browser can send requests to `127.0.0.1`, so
every request must have a local `Host` header (`localhost`, `127.0.0.1` or `[::1]`, any port; this
defeats DNS rebinding), a browser's `Origin` header, when sent, must be a local page, and every `/api/*`
call must carry the process's random 32-byte session token in `x-orch-token` (or `?token=` for the
event stream, since `EventSource` cannot set headers). The UI reads the token from `GET /api/token`,
which another site cannot read (no CORS, and `Origin` / `Sec-Fetch-Site: cross-site` are refused).
The token changes when the server restarts; `transport.ts` then fetches it again, retries once, and
reconnects the event stream. Vite's dev proxy (`localhost:5173`) passes the checks.

| Route | Purpose |
|---|---|
| `GET /api/token` | The session token (see the request guard) |
| `GET /api/events?token=` | SSE: `init`, `session`, `log`, `ev`, `global` |
| `GET /api/state` | The init payload |
| `GET /api/doctor?repo=`, `/api/agents?repo=` | `orch doctor --json`, roster |
| `GET /api/plugins?repo=[&fresh]` | `orch plugins --json --details` (cached 10 minutes) |
| `POST /api/add-repo` `{ path }`, `/api/remove-repo` `{ repo }` | Open or close a repo (closing is refused while it runs) |
| `POST /api/settings` `{ maxParallel?, dailyBudget?, usageCap?: { fiveHour?, week? } }` | Change the parallel limit, the daily budget and/or the usage caps in percent (`null` or `""` = none) |
| `POST /api/clear-limit` | Lift the usage-limit hold ("Try now") |
| `POST /api/stop-after` `{ repo }` | Ask the running queue loop to stop before its next goal |
| `POST /api/run`, `/add`, `/loop`, `/stop`, `/clear-log`, `/rollback` | Actions on `{ repo, … }`; `stop` also cancels a start waiting for a slot |
| static | serves `dist/` |

### Backend B: desktop mode (`src-tauri/src/main.rs`)

Tauri v2. Replaces the Node server. Runs the compiled `orch.mjs` with `node` in each repo.

| Command | Purpose |
|---|---|
| `snapshot` | The init payload |
| `add_repo(path)`, `remove_repo(repo)`, `set_max_parallel(maxParallel)` | Open or close a repo, change the limit; persisted to `<app config>/repos.json` (the old single `repo.txt` is migrated) |
| `set_daily_budget(dailyBudget)`, `set_usage_cap(fiveHour, week)`, `clear_limit` | Daily budget and usage caps (`null` = none); lift the usage-limit hold and forget usage readings |
| `run_goal`, `run_loop`, `add_goal`, `stop`, `clear_log`, `agents`, `rollback` | Same actions as the HTTP API, each with `repo` |
| `doctor(repo)` | `orch doctor --json` (async command, so starting node does not freeze the window) |
| `plugins(repo)` | `orch plugins --json --details` (async) |

Events to the UI: `orch-init`, `orch-session`, `orch-log`, `orch-ev` (these two as `{ repo, … }`), `orch-global`.

Internals: one `Mutex<Inner>` holds the sessions (repo, running process, pending start, log ring of 5000
lines, events of the current goal), the start queue, `max_parallel` and the global hold and budget.
A ticker thread (30 s) lifts an expired hold, starts a new budget day and starts what waits. Two reader threads per child
feed `push_line`, which splits structured lines from plain ones. A wait thread joins the readers before
reporting exit, so the last output is never lost, then starts the next queued repo. Stop uses
`taskkill /T /F` on Windows and a process-group `kill` elsewhere; the app does this for every running
repo on exit. `orch.mjs` is built from `../orch.ts` by esbuild into `src-tauri/resources/` and bundled as
a resource. Lookup order: `ORCH_PATH`, bundled resource, dev manifest path.

## Concurrency and state files

- **Run lock** (`.orchestrator/run.lock`): `run`, `loop`, `learn` and `rollback` take it, so only one orch drives a
  repo. It records pid, host, command and start time; the holder touches it every 30 s and removes it on exit
  (only if it is still its own). A new process takes it over only if the holder's process is gone (same host)
  or the lock has not been touched for 2 minutes (a reused pid, or another machine); otherwise it stops with
  who holds it. `add`, `status` and the UI's reads do not take it.
- **Queue edits** (`updateQueue`): every read-modify-write of `queue.json` (`add`, the loop claiming and
  finishing goals) runs under a short `.orchestrator/queue.lock`, so goals added while a loop runs are never
  lost; a queue lock older than 10 s is from a process that died mid-edit. The browser server adds goals
  through `orch add` for the same reason.
- **Atomic writes**: `queue.json`, `last-run.json`, `brief.md` and `notes.md` are written to a temp file and
  renamed (retried briefly on Windows while a reader has the file open). A `queue.json` that is not valid is
  reported and left untouched, never overwritten.
- **Stop after this goal**: `orch stop-after` (or the UI's **Stop after this goal** while a queue runs)
  creates `.orchestrator/stop-after-goal`; the loop checks it before each goal and while waiting for a usage
  limit, removes it and exits with `loop_stop`. A request left from an earlier loop is cleared at start.

## Data on disk

| Path | Owner | Content |
|---|---|---|
| `<target>/.orchestrator/queue.json` | orch.ts / UI | Queue |
| `<target>/.orchestrator/last-run.json` | orch.ts | Latest goal: status, total cost, `checkpoint` (only while that branch exists; drives the UI's rollback offer), and per round power, plan, touched files, checks, failures, cost |
| `<target>/.orchestrator/readonly-settings.json` | orch.ts | Allow-list plus edit-tool deny for the architect and verifiers |
| `<target>` git branches `orchestrator/discarded-*` | orch.ts | Work thrown away by `orch rollback` |
| `<target>/.orchestrator/run.lock`, `queue.lock`, `stop-after-goal` | orch.ts | Run lock, queue edit lock, stop request (see Concurrency) |
| `<target>/.orchestrator/notes.md` | orch.ts | Lessons from earlier goals, read by the architect; never committed |
| `<target>/.orchestrator/brief.md` | orch.ts (written by the architect) | Project brief reused by later rounds, goals and all agents; first line `<!-- orch: written at commit … -->`; never committed |
| `<target>/.orchestrator/builtin-agents.json` | orch.ts | Built-in agent definitions passed to `claude --agents` |
| `<target>/.orchestrator/agent-settings.json` | orch.ts | Permission allow-list passed to `claude --settings`, plus `enabledPlugins` (ids set to false) and `disableAllHooks` when plugins or hooks are switched off |
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
