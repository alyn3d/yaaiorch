# Repo groups: one goal across a frontend and a backend repo

Status: design, approved approach A (2026-11-19).

## Intent

A user works on two connected repos (for example a work frontend and its backend API). Today every YAAIORCH run is
bound to one repo: agents only see that repo, so a frontend run guesses the backend's routes and payloads, and a
feature that needs both sides takes two unrelated goals the user has to keep in step by hand.

A **repo group** lets the user give one goal ("add avatars to user profiles") and have both sides planned against one
API contract, built, and verified together against the locally running backend, ending in normal local commits in each
repo.

## Goals

- Define a group of repos with a role each. Version 1: exactly one `backend` and one `frontend`; config validation
  rejects anything else (duplicate roles, other roles, a single repo). N repos and other roles are later work.
- One group goal → a coordinator writes an API contract and one sub-goal per repo.
- Each repo's sub-goal runs through today's normal loop (plan, build, checks, QA, commits), in parallel where the
  start queue allows, with the contract in every agent's prompt and the other repos readable.
- An integration step: start the backend locally, run the frontend's checks, browser checks and QA against it; on
  failure the coordinator decides which side is at fault and runs a fix sub-goal there; repeat up to a limit.
- End state on success: commits on each repo's current branch, as a single-repo run leaves today.
- One group rollback that resets every repo to where the group goal started.
- CLI first, with events; then UI.

## Non-goals

- PRs or branch-per-goal for groups (the user wants local commits). `--branch`/`--pr` may be passed through later; not
  designed here.
- A single run whose plan spans repos (approach B, rejected below).
- Monorepos (already one repo; nothing to do).
- Group queues, loop/intake over groups, issue intake. A group goal is started one at a time.
- Evals for groups in this iteration.

## Anti-goals (failure even if it "works")

- An agent in repo A writing files in repo B. Other repos are read-only to it, enforced, not just asked.
- One repo left with half a feature committed while the group goal failed, without the user being told and without a
  one-step way back.
- Any change in behaviour for a plain single-repo run, its events, or its tests.
- Two processes running in the same repo at once (the group must respect each repo's `run.lock`).

## Constraints

- `orch.ts` assumes `process.cwd()` is the repo everywhere (`badPath`, checks, commits, checkpoints, resume, unowned
  files, `.orchestrator/` state). This design keeps that: every repo-touching run is a child `orch` process started in
  that repo.
- Windows is the primary target: children spawned without a shell, `windowsHide`, process-tree kill on stop.
- Event protocol: new events must be added to `server.ts`, `main.rs` and `reduce.ts` together, plus
  `docs/ARCHITECTURE.md`'s table and the list in `CLAUDE.md`.
- No personal paths in committed files; group config lives in the user's home dir.
- Testable without tokens through `test/fake-claude/`. New loop behaviour needs scenarios.

## Approaches

**A. Repo group with a coordinator (chosen).** A new `orch group` command is the coordinator. It plans the contract
and sub-goals with a read-only agent that sees all repos, then starts ordinary `orch run` child processes in each
repo, then an integration pass. Reuses the whole per-repo loop untouched; cost: a cross-side bug takes an extra
round trip (integration → fix sub-goal → integration).

**B. One run across repos.** Plan tasks name a repo; one process drives agents, checks and commits in several repos.
Tighter feedback (one QA sees both sides), but every cwd assumption in `orch.ts` changes. Big, risky rewrite.
Rejected.

**C. Read-only awareness only.** Each run can read the other repo; the user queues two goals by hand. Cheap, but no
single goal and no integration check. Rejected as the end state; it falls out of A anyway (see `--group-context`).

The user picked A.

## Design

### Group config

`~/.yaaiorch/groups/<name>.json` (name: plain `[a-z0-9-]+`):

```json
{
  "name": "shop",
  "repos": [
    { "path": "D:/work/shop-api", "role": "backend",
      "serve": { "command": "npm run dev", "url": "http://localhost:3000/health", "baseUrl": "http://localhost:3000" } },
    { "path": "D:/work/shop-web", "role": "frontend", "env": { "VITE_API_URL": "{backend}" } }
  ],
  "contract": "openapi.yaml",
  "integrationRounds": 2
}
```

- `serve` on the backend: how to start it and a URL that answers when it is up (localhost only, `isLocalUrl`). If
  absent, the backend repo's own `.orchestrator/config.json` `serve` is used; if neither, the integration step is
  skipped with a warning event.
- `baseUrl` on the backend's `serve`: the API base the frontend should call (defaults to the origin of `url`).
- `env` on the frontend: environment variables set for all the frontend's children (build, integration and fix; changed during the build, it was integration and fix only), which pass them on
  to everything they start (dev server, checks, browser checks). `{backend}` is replaced by the backend's `baseUrl`.
  This is how the user's frontend finds the backend (an env var such as `VITE_API_URL`). Process env must win over
  the frontend's `.env` files (true for Vite and most tools; the builder confirms `DEV_SERVER` and `runChecks`
  inherit the child's env). Names must be plain `[A-Z_][A-Z0-9_]*`; values are not secrets and may be logged.
- `contract` (optional): the text of a standing API contract, which the coordinator keeps and extends (changed during the build: the design had a path to a machine-readable contract in the backend repo, the code takes the text).
- CLI: `orch group add <name> --repo PATH:ROLE ... [--serve-command C --serve-url U]`, `orch group list`,
  `orch group remove <name>`. Writes go through `writeFileAtomic`.

### Group run: `orch group run <name> "<goal>"`

Group state for the run lives in `~/.yaaiorch/groups/<name>/` (`run.lock`, `last-run.json`, `contract.md`). Steps:

1. **Lock and checkpoint.** Take the group lock, then take every member repo's `run.lock` (`acquireRunLock`, cmd
   `group`) and hold them for the whole group run, so nothing else starts in a member repo between steps. Children
   inherit the lock: the group passes the lock id in `ORCH_GROUP_LOCK`, and `acquireRunLock` accepts a held lock
   whose id matches (and then neither re-writes nor releases it). Refuse if any member repo is locked or dirty (same
   rule as `run`). Record each repo's HEAD in `last-run.json` and create
   `orchestrator/group-checkpoint-<stamp>` in each repo.
2. **Contract.** A read-only coordinator agent (built-in `coordinator`, swappable like other roles, architect-tier
   model) runs with all repos as `--add-dir`, the goal, each repo's brief if present, and the existing contract file
   if configured. It returns:
   - `contract`: markdown, the routes/messages/payloads/errors/auth this goal adds or changes;
   - `goals`: `{repo role → sub-goal text}`, may omit a repo with nothing to do.
   The contract is written to the group dir and copied into each repo as `.orchestrator/contract.md` (state, never
   committed). Event `group_plan`.
   With `--approve-plan`, the contract and sub-goals wait for approval like a plan (`awaitDecision`, decision written
   by `orch approve --group <name>`).
3. **Build.** Start `orch run "<sub-goal>"` in each repo as a child process (`ORCH_EVENTS=1`) with new hidden flags:
   - `--group-context <file>`: adds the contract to every architect, implementer and QA prompt (like
     `specForPrompt`) and tells agents which other repos exist, their role, and that they are read-only.
   - `--read-dir <path>` (repeatable): passes `--add-dir` for the other repos to agents **and** writes deny rules
     for `Edit/Write/MultiEdit/NotebookEdit` on those paths into the agents' `--settings`, so writes there are refused
     (Anti-goal 1). If the CLI's path-scoped deny rules turn out not to hold under `acceptEdits`, fall back to no
     `--add-dir` and put the other repo's relevant files (contract file, route/type files the coordinator names) into
     the prompt instead. The builder must verify which works with a real `claude` before relying on it.
   - Shell writes: group children never get `--commands` (Agent M), so a shell command that needs permission is
     refused, as in any headless run without it. A write that still lands in the other repo shows up there as an
     `unowned` file in that repo's own child (it is outside every task's file list). Group children run with
     `--strict-files`, so such a leak fails that round instead of being committed. Detection plus refusal is the bar;
     attributing which child wrote it is not required.
   - The group's remaining `--max-cost` share, `--on-limit`, model and power options are passed through.
   Children run in parallel (both repos at once). Each child keeps its own checkpoint/commit behaviour; the group
   checkpoint is what rollback uses.
4. **Integration.** When every child passed: start the backend's `serve.command` in the backend repo (killed on exit,
   same handling as `DEV_SERVER`), wait for its URL, then run a child `orch run` in the frontend repo with an
   integration goal ("verify the frontend works against the running backend for this contract; fix the frontend if
   it does not") and `--group-context`. Its checks, browser checks and QA run with the real backend up.
   - Pass → group passes.
   - Fail → the coordinator gets the failure report (QA verdict, failing checks, browser problems, backend server
     log tail) and answers `{fault: backend|frontend|both, goals: {role → fix goal}, contract?}`. When it returns a
     revised `contract`, orch rewrites it into the group dir and both repos' `.orchestrator/contract.md` (event
     `group_plan` again, with `revised: true`) and the fix goals run against it. orch runs the fix sub-goal(s), in
     parallel when both, (backend fix: backend server restarted after), then integration again. At most
     `integrationRounds` (default 2).
   - Integration and fix children always run with `--no-fast`, so QA (not just the checks) gives the verdict.
5. **End.** Pass: delete group checkpoints, event `group_end {ok: true}`. Fail (or stopped): in every repo, move the
   group's work to `orchestrator/failed-group-<stamp>` and reset to the group checkpoint (same mechanics as `loop`'s
   failure handling, `--no-verify` for the parking commit), event `group_end {ok: false, parked: {...}}`.
   `orch group rollback <name>` does the same after a pass, from `last-run.json`.

A usage limit in any child stops the group (children are killed, work parked as in step 5's fail path, the group
reports `UsageLimit`); `--on-limit wait` waits and restarts the group goal from the step that was interrupted. Keep
this simple: restarting the interrupted step from its parked work is the builder's call.

### Events

The group process prints its own events and re-emits each child's events wrapped:

- `group_start {group, goal, repos: [{path, role}]}`
- `group_plan {contract, goals, cost}`
- `group_step {step: "build"|"integration"|"fix", repo, round}`
- `group_child {repo, event}`: a child's event, unchanged inside.
- `group_end {ok, reason?, parked?}`

Cost events inside `group_child` count toward the daily budget (`COST_EVENTS` unwrapped in both backends), plus
`group_plan`'s cost and the coordinator's fault calls.

### UI (second phase)

- Groups section: create/edit a group from repos already open (role picker, backend serve command/URL).
- A group goal box on the group page; start goes through the same start queue and holds (usage limit, budget). A
  group run occupies every member repo's session: those repos show "running in group <name>" and refuse their own
  starts.
- Backends demux `group_child` into the member repo's session so each repo's existing run view, task list, logs and
  rollback work as today; the group page shows the contract, sub-goals, step and integration rounds.
- Stop on the group stops the group process tree (children included).
- `server.ts`, `main.rs`, `transport.ts` stay in sync; new routes behind the `/api` guard.

### Tests

- Scenarios (fake claude, two temp repos): happy path; integration fail with backend fault → backend fix → pass;
  integration rounds exhausted → both repos reset and parked; dirty member repo refused; member repo locked refused;
  child writing into the other repo is refused or reported; group rollback.
- Fake claude: answer prompts starting with the coordinator's preamble (contract + goals, fault calls), with a switch
  for the fault side.
- Unit: group config validation, `group_child` folding in `reduce.ts`, cost counting of wrapped events.

## Decided by the user

- Coordinated goals, approach A.
- End result: commits on the repos' current local branches, no PRs.
- The backend runs locally; frontend verification should run against it.
- The frontend finds the backend through an environment variable (configured per group, see `env`).

## Calls made in this design (correctable)

- Coordination lives in `orch.ts` (`orch group`), not in the backends, so it is written once and tested with the fake
  claude; backends only start it and demux events.
- Build sub-goals run in parallel, against the contract; integration is a separate frontend run with the backend up.
- On group failure both repos are reset and the work parked, mirroring `loop`, rather than keeping a passing side's
  commits.
- Contract copied into each repo's `.orchestrator/` (never committed); config and run state in `~/.yaaiorch/groups/`.
- CLI and events first, UI second.
- Version 1 is exactly one backend plus one frontend.
- The group holds both repos' `run.lock` for the whole run; children inherit it through `ORCH_GROUP_LOCK`.
- No Agent M for group children; `--strict-files` turns a write leaking into the other repo into a failed round.
- A fix round may revise the contract; it is rewritten into both repos.
- Integration and fix children always run `--no-fast`.

## Left to the builder

- Coordinator prompt wording and reply format details (follow the existing reply-format pattern in `orch.ts`).
- How the `--read-dir` deny rules are expressed, after checking the CLI's behaviour (see step 3).
- Splitting `orch.ts` code into a new module (e.g. `orch-group.ts`, bundled like `orch-browser.ts`) — recommended.
- Exact UI layout of the group page, following the current design.
- Docs: README, ARCHITECTURE event table, CLAUDE.md event list, CHANGELOG `[Unreleased]`, TODO.
