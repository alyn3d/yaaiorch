# Repo Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orch group run <name> "<goal>"` plans one API contract for a backend and a frontend repo, builds both
through the normal per-repo loop, verifies the frontend against the locally running backend, and ends in local
commits in both repos (or both reset and parked).

**Architecture:** A new module `orch-group.ts` (bundled into `orch.mjs` like `orch-browser.ts`) holds the group
config, coordinator prompts and the group state machine. Everything that touches a repo stays a child `orch` process
started in that repo: `orch run` for build/integration/fix, and a hidden `orch group-member` for checkpoint/park/reset,
so `orch.ts`'s `process.cwd()` assumption is untouched. The group process holds every member's `run.lock` and hands it
to children through `ORCH_GROUP_LOCK`.

**Tech Stack:** TypeScript (Node ≥ 20, tsx in tests), `node:test`, fake claude (`test/fake-claude/`), React reducer
(`orch-ui/src/reduce.ts`), `server.ts`, Rust `main.rs`.

**Spec:** `docs/superpowers/specs/2026-11-19-repo-groups-design.md`

**Scope of this plan:** CLI, events and both backends' event handling (cost, demux). The UI group page is the spec's
second phase and gets its own plan after this one ships.

## Global Constraints

- Plain single-repo runs: no change in behaviour, events or existing tests. `npm test` stays green after every task.
- Version 1: exactly one `backend` and one `frontend` repo per group; anything else is rejected at config time.
- Group names `^[a-z0-9-]+$`; env var names `^[A-Z_][A-Z0-9_]*$`; `serve.url` and `baseUrl` must pass `isLocalUrl`.
- Group config: `~/.yaaiorch/groups/<name>.json`; run state: `~/.yaaiorch/groups/<name>/` (`run.lock`,
  `last-run.json`, `contract.md`). Home overridable with `YAAIORCH_HOME` (tests). Writes via `writeFileAtomic`.
- Contract copied to each repo's `.orchestrator/contract.md` (never committed).
- Group children: never `--commands`; always `--strict-files`; integration and fix children always `--no-fast`;
  always `--on-limit stop`.
- `integrationRounds` default 2.
- Children spawned without a shell, `windowsHide: true`; stop kills the process tree.
- New events: `group_start`, `group_plan`, `group_step`, `group_child`, `group_end`. Added in the same change to
  `server.ts`, `main.rs`, `reduce.ts`, `docs/ARCHITECTURE.md` event table and `CLAUDE.md`'s event list.
- Never log a secret's value. No personal paths in committed files. CHANGELOG `[Unreleased]` in the same change.
- Formatting: Prettier printWidth 160; `npm run lint` and `npm run format:check` pass.

## Review Focus

1. **A repo path in the group config that no longer exists, or is not a git repo** → `group run` refuses before
   locking anything, naming the path. Test in Task 6 (`refuses a missing member repo`).
2. **Stop (SIGINT/SIGTERM) mid-build** → children's process trees die, both repos are parked and reset, every lock is
   released. Test in Task 6 (`stop mid-build parks both repos and releases locks`).
3. **Backend port already in use / serve command exits** → integration reports the dev server error (with log tail)
   as an integration failure the coordinator sees, never a hang. Test in Task 7 (`backend that never answers fails integration`).
4. **The frontend's own `.orchestrator/config.json` sets `serve` too** → the frontend dev server still starts with the
   group `env` applied (env reaches `DevServer` because it inherits the child's env). Test in Task 7 (`env reaches
   the frontend checks`) covers checks; the browser path is covered by the same inheritance, noted in review.
5. **A plain `orch run` in a member repo while a group runs** → refused with the existing "another orch is already
   running" error naming cmd `group`. Test in Task 2 (`plain run refused while group holds the lock`).

---

### Task 1: Group config (`orch-group.ts`) and `orch group add|list|remove`

**Files:**
- Create: `orch-group.ts`
- Modify: `orch.ts` (import; `case "group"` in `main()` dispatching `add|list|remove`; new options `repo` (string,
  multiple), `serve-command`, `serve-url`, `base-url`, `env` (string, multiple `NAME=VALUE`); usage text; re-export
  pure helpers in the bottom `export {}` block)
- Test: `test/group.test.mjs` (new; picked up by `node --test "../test/*.test.mjs"`)

**Interfaces:**
- Produces:
  - `type GroupRole = "backend" | "frontend"`
  - `type GroupRepo = { path: string; role: GroupRole; serve?: { command?: string; url: string; baseUrl?: string; timeout?: number }; env?: Record<string, string> }`
  - `type GroupConfig = { name: string; repos: GroupRepo[]; contract?: string; integrationRounds?: number }`
  - `groupsDir(): string` (`$YAAIORCH_HOME` or `~/.yaaiorch`, + `/groups`)
  - `validateGroup(v: unknown): GroupConfig` (throws `Error` with a readable message)
  - `readGroup(name: string): GroupConfig`, `writeGroup(g: GroupConfig): void`, `listGroups(): GroupConfig[]`, `removeGroup(name: string): void`
  - `memberOf(g: GroupConfig, role: GroupRole): GroupRepo`
  - `backendBaseUrl(g: GroupConfig): string | undefined` (`serve.baseUrl`, else origin of `serve.url`)
  - `groupEnv(g: GroupConfig): Record<string, string>` (frontend `env` with `{backend}` replaced by `backendBaseUrl`)

- [ ] **Step 1: Write failing unit tests** in `test/group.test.mjs` (import `orch.ts` with `ORCH_NO_MAIN=1` as
  `unit.test.mjs` does):
  - `validateGroup` accepts the spec's example (paths made absolute temp dirs) and returns `integrationRounds` undefined.
  - rejects: name `"Shop!"`; two `backend`s; a `worker` role; a single repo; `serve.url` `"http://example.com"`;
    env name `"vite-api"`; relative repo path; `integrationRounds: 0`.
  - `groupEnv` on `{env: {VITE_API_URL: "{backend}"}}` with `serve: {url: "http://localhost:3000/health"}` →
    `{VITE_API_URL: "http://localhost:3000"}`; with `baseUrl: "http://localhost:3000/api"` → that value.
- [ ] **Step 2: Run** `cd orch-ui && node --test ../test/group.test.mjs` → FAIL (exports missing).
- [ ] **Step 3: Implement the interfaces above** in `orch-group.ts`; `writeGroup` validates first. Repo paths are
  stored resolved (`resolve()`), not checked for existence here (Task 6 checks at run time).
- [ ] **Step 4: Scenario test** (same file): `orch group add shop --repo <be>:backend --repo <fe>:frontend
  --serve-command "node server.js" --serve-url http://localhost:PORT/ --env VITE_API_URL={backend}` with
  `YAAIORCH_HOME=<tmp>` writes `<tmp>/groups/shop.json` matching; `orch group list --json` prints it; `orch group
  remove shop` deletes it; `add` with a bad role exits non-zero with the validation message.
- [ ] **Step 5: Implement the CLI cases**, run `node --test ../test/group.test.mjs` → PASS, then `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(group): group config and orch group add|list|remove`

### Task 2: Run lock at a root, and inherited group lock

**Files:**
- Modify: `orch.ts:391-460` (`acquireRunLock`), new export
- Test: `test/group.test.mjs`

**Interfaces:**
- Produces:
  - `acquireRunLock(cmd: string, root = process.cwd()): string` — returns the lock id. Lock file
    `join(root, DIR, "run.lock")`; stale/question/command cleanup stays limited to `root === process.cwd()`.
  - `ORCH_GROUP_LOCK` env: when set and the existing lock file's `id` equals it, `acquireRunLock` succeeds without
    writing, without the heartbeat and without the release-on-exit (the group owns it). When set and it does not match
    (or no lock exists), it throws `group lock mismatch`.
  - `releaseRunLock(id: string, root: string): void` (deletes only if the id matches).

- [ ] **Step 1: Failing tests:**
  - `plain run refused while group holds the lock`: call `acquireRunLock("group", repoDir)` in-process (unit import),
    then `orch run "x"` in `repoDir` exits non-zero with `another orch is already running in this repo (group`.
  - `child with ORCH_GROUP_LOCK runs`: same lock, `orch run "x"` with `ORCH_GROUP_LOCK=<id>` passes, and the lock
    file still exists with the same id afterwards.
  - `mismatched ORCH_GROUP_LOCK refused`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The group process heartbeats each lock it holds (same 30 s `utimesSync`).
- [ ] **Step 4: Run** group tests and `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(group): run lock at a root, inherited by group children`

### Task 3: Member-run flags `--group-context` and `--read-dir`

**Files:**
- Modify: `orch.ts`: options table (`group-context` string, `read-dir` string multiple); `Opts` gets
  `groupContext?: string` (file contents) and `readDirs: string[]`; `parseOpts`; `RunCtx` gets `addDirs: string[]`;
  `runOnce` args add `...ctx.addDirs.flatMap(d => ["--add-dir", d])` (skip when `claudeBin().shell`, as Agent M chat
  does at `orch.ts:1795`); `writeAgentSettings` gains `readDirs: string[]` and adds deny rules; architect prompt next
  to `specForPrompt()` (`orch.ts:3296`) and `ctx.repoContext` (`orch.ts:4361`) get the group section.
- Modify: `test/fake-claude/fake-claude.mjs`: `FAKE_LOG` line also carries `adddirs=<a|b>` when `--add-dir` given;
  header comment documents it.
- Test: `test/group.test.mjs`

**Interfaces:**
- Produces:
  - `groupSection(contract: string, others: { role: string; path: string }[]): string` — markdown: "This repo is part
    of a group… other repos (read-only, never write there): …" + "## API contract\n" + contract.
  - Deny rules, per read dir `d` (forward slashes): `Edit(//${d}/**)`, `Write(//${d}/**)`, `MultiEdit(//${d}/**)`,
    `NotebookEdit(//${d}/**)` in both `AGENT_SETTINGS` and `READONLY_SETTINGS` `permissions.deny`.

- [ ] **Step 1: Failing tests** (`member flags reach agents`): run `orch run "x" --group-context <file with
  "CONTRACT-MARKER"> --read-dir <otherRepo>` with fake claude; assert every agent log line has
  `adddirs=<otherRepo>`; `.orchestrator/agent-settings.json` `permissions.deny` contains `Edit(//<otherRepo>/**)`;
  fake claude's prompt dump (`FAKE_PROMPTS=<dir>` if present, else add it: write each prompt to `<dir>/<n>.txt`)
  contains `CONTRACT-MARKER` for architect, implementers and QA. Unit: `groupSection` contains both repos' roles.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Manual check against the real CLI** (costs a few cents; skip in CI): in a scratch repo with a sibling
  scratch dir, run `orch run "write the word hi into <sibling>/x.txt" --read-dir <sibling> --power economy --no-fast`.
  Expected: `<sibling>/x.txt` not created. If it IS created, switch to the spec's fallback (drop `--add-dir`, keep the
  prompt section; note it in the commit and CHANGELOG) before continuing.
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(group): --group-context and read-only --read-dir for member runs`

### Task 4: Hidden `orch group-member` actions

**Files:**
- Modify: `orch.ts` (`case "group-member"`; not in usage text)
- Test: `test/group.test.mjs`

**Interfaces:**
- Consumes: `ORCH_GROUP_LOCK` check from Task 2 (every action requires it and calls `acquireRunLock("group-member")`).
- Produces (all print one JSON line on stdout, exit 0 on success):
  - `orch group-member checkpoint <stamp>` → refuses a dirty tree (same message as `run`); creates
    `orchestrator/group-checkpoint-<stamp>` at HEAD → `{"checkpoint": "<branch>", "head": "<sha>"}`
  - `orch group-member park <checkpoint> <failed|interrupted>` → `moveWorkAside` with kind mapped to branch
    `orchestrator/<kind>-group-<stamp>` → `{"parked": "<branch>" | null}`
  - `orch group-member reset <checkpoint>` → parks as `discarded` then resets (rollback) → `{"parked": ...}`
  - `orch group-member drop <checkpoint>` → deletes the checkpoint branch → `{}`

- [ ] **Step 1: Failing tests:** in a temp repo with a held group lock: checkpoint on dirty tree fails; checkpoint →
  commit a change → park failed → HEAD equals checkpoint and `orchestrator/failed-group-<stamp>` holds the change;
  drop removes the branch; any action without `ORCH_GROUP_LOCK` fails.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (reuse `moveWorkAside`; extend its `kind` naming so
  `group-checkpoint-X` → `failed-group-X`). **Step 4: Run** → PASS, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(group): group-member checkpoint/park/reset/drop`

### Task 5: Coordinator agent and fake claude support

**Files:**
- Modify: `orch-agents.ts` (built-in `coordinator`: read-only, architect tier; swappable via config `swap`)
- Modify: `orch.ts` (`modelFor` role `coordinator` → architect tier; add to swap role list)
- Modify: `orch-group.ts` (prompts + parsers)
- Modify: `test/fake-claude/fake-claude.mjs`
- Test: `test/group.test.mjs`

**Interfaces:**
- Produces:
  - `type GroupPlan = { contract: string; goals: Partial<Record<GroupRole, string>> }`
  - `type FaultCall = { fault: GroupRole | "both"; goals: Partial<Record<GroupRole, string>>; contract?: string }`
  - `coordinatorPlanPrompt(g: GroupConfig, goal: string, briefs: Partial<Record<GroupRole, string>>, existingContract?: string): string` — starts with `"You are the group coordinator."`
  - `coordinatorFaultPrompt(g: GroupConfig, goal: string, contract: string, report: string): string` — same preamble
  - `orch group-member coordinate <plan|fault> --group <name>` (needs `ORCH_GROUP_LOCK`; prompt inputs as JSON on
    stdin `{goal, contract?, report?, briefs}`): runs the `coordinator` through `runOnce` read-only with
    `--read-dir <other member>` and prints `{"reply": <GroupPlan|FaultCall>, "cost": n}`. Used by Tasks 6 and 7.
  - `parseGroupPlan(text: string): GroupPlan` / `parseFaultCall(text: string): FaultCall` — JSON in the reply
    (same fenced-JSON extraction the plan parser uses); throw on missing contract, no goals, unknown roles, a fault
    side without its goal.
- Fake claude: prompts starting `"You are the group coordinator."` answer a plan (`contract: "GET /api/items → Item[]"`,
  both goals) or, when the prompt contains `"Integration failed"`, a fault call from `FAKE_GROUP_FAULT=backend|frontend|both`
  (default frontend); `FAKE_GROUP_REVISE=1` adds `contract: "REVISED"`. New switch `FAKE_QA_FAIL_INTEGRATION=<n>`:
  QA fails a goal containing `"against the running backend"` the first n times (counter in `.orchestrator/fake-integration`).

- [ ] **Step 1: Failing unit tests** for both parsers (good reply, missing contract, `fault: "both"` with one goal,
  unknown role) and that both prompts contain each repo's role and path. Scenario: `group-member coordinate plan`
  in a repo with a held group lock prints a reply with `contract` and both goals; the fake log shows agent
  `coordinator` in permission mode `default` with `adddirs=<other repo>`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(group): coordinator agent, prompts and reply parsing`

### Task 6: `orch group run`: lock, plan, parallel build, end

**Files:**
- Modify: `orch-group.ts` (`runGroup`), `orch.ts` (`case "group"` → `run` and options `--max-cost`, `--power`,
  `--model`, `--approve-plan`, passed through)
- Test: `test/group.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `runGroup(g: GroupConfig, goal: string, o: GroupOpts): Promise<"pass" | "fail" | "limit">`;
    `GroupOpts = { maxCost?: number; power: string; model?: string; approvePlan: boolean; agentTimeout: number }`
  - `selfArgs(): string[]` → `[...process.execArgv, resolve(process.argv[1])]` (same as `orch.ts:1500`)
  - `runChild(repo: GroupRepo, args: string[], env: Record<string,string>, onEvent: (e) => void): { done: Promise<number>; kill(): void }`
    — spawns `process.execPath, [...selfArgs(), ...args]` with `cwd: repo.path`, `ORCH_EVENTS=1`, `ORCH_GROUP_LOCK`,
    `windowsHide`; parses `@@ORCH@@` lines → `onEvent`; other stdout/stderr lines are printed prefixed `[<role>] `.
  - Events printed by the group: `group_start {group, goal, repos:[{path, role}]}`, `group_plan {contract, goals,
    cost, revised?}`, `group_step {step: "build"|"integration"|"fix", repo?: role, round}`,
    `group_child {repo: <path>, role, event}`, `group_end {ok, reason?, parked?: Record<role, string|null>}`.
  - Exit codes: pass 0, fail 1, usage limit 3.
- Flow: validate members exist and are git repos → take group lock + both repo locks (Task 2) → `group-member
  checkpoint` in both (any failure: release and exit 1) → coordinator plan (via `runOnce`-equivalent: spawn the
  coordinator as `orch group-member coordinate` in the backend repo with `--read-dir <frontend>`, which prints the
  reply JSON; this reuses `runOnce`, budget and model plumbing) → write contract to group dir and both repos'
  `.orchestrator/contract.md` → with `--approve-plan`, `awaitDecision`-style wait on `<group dir>/plan-decision.json`
  written by `orch approve --group <name>` → build: `orch run "<goal>" --group-context <contract file> --read-dir
  <other> --strict-files --on-limit stop --max-cost <remaining/2>` in both, in parallel; a repo with no goal is skipped
  → any child exit 3 → park both as `interrupted`, `group_end {ok:false, reason:"UsageLimit"}`, exit 3 → any other
  non-zero → park both `failed`, exit 1 → (Task 7 integration) → pass: `drop` both checkpoints, `group_end {ok:true}`.
  `last-run.json` in the group dir records `{goal, stamp, checkpoints, ok, parked}`. SIGINT/SIGTERM: kill children,
  park both `interrupted`, release locks, exit 130.

- [ ] **Step 1: Failing scenarios** (two temp repos per test, `YAAIORCH_HOME` temp, fake claude, no `serve` so
  integration is skipped with a warning):
  - `happy path builds both repos`: exit 0; `group_end.ok`; each repo has a new commit on its branch and no
    `orchestrator/group-checkpoint-*`; both repos' `.orchestrator/contract.md` contains `GET /api/items`;
    `group_child` events carry both paths.
  - `build failure parks both`: `FAKE_FAIL_AGENT=be` → exit 1, both repos back at their start HEAD, both have
    `orchestrator/failed-group-*`.
  - `refuses a dirty member repo` / `refuses a locked member repo` / `refuses a missing member repo`: exit 1, no
    branches created, no lock files left.
  - `approve-plan waits for orch approve --group`: start with `--approve-plan` via `orchAsync`, wait for
    `<group dir>/plan-pending.json`, run `orch approve --group shop`; the group continues and exits 0. A rejection
    (`--reject "why"`) re-runs the coordinator with the reason in its prompt.
  - `stop mid-build parks both repos and releases locks`: `FAKE_SLOW=5`, start with `orchAsync`, SIGTERM after the
    first `task_start`; both repos at start HEAD, `orchestrator/interrupted-group-*` present, no `run.lock` anywhere.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** group tests and `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(group): orch group run with coordinator plan and parallel build`

### Task 7: Integration step and fix loop

**Files:**
- Modify: `orch-group.ts` (`integrate` inside `runGroup`)
- Test: `test/group.test.mjs`, test fixture `test/fixtures/group-backend.mjs` (tiny HTTP server on `PORT` env
  answering 200 `ok`)

**Interfaces:**
- Consumes: `DevServer` from `orch-browser.ts` — add an optional `cwd` to its constructor options
  (`new DevServer(cfg, { cwd })`, used in `spawn` at `orch-browser.ts:368`; default unchanged) and keep `tail()` public.
- Produces: backend serve resolution `groupServe(g): ServeConfig | undefined` (group `serve`, else backend repo's
  `.orchestrator/config.json` `serve`, else undefined → `group_step {step:"integration", skipped:"no serve"}` and pass).
- Flow per round r (1..`integrationRounds`): `DevServer.ensure()`; an error string is an integration failure report
  (no child run) → else child `orch run "Verify the frontend works against the running backend at <baseUrl> for this
  contract; fix the frontend if it does not." --group-context … --read-dir <backend> --strict-files --no-fast
  --on-limit stop` in the frontend repo with env `groupEnv(g)` → pass: done. Fail: report = child's last QA verdict
  text + failed checks (from its `task_end`/`checks` events) + `DevServer.tail()` → coordinator fault call →
  revised contract rewritten (+ `group_plan {revised:true}`) → fix children (`group_step {step:"fix"}`, `--no-fast`,
  parallel when `both`; backend fix → `DevServer.restart()`) → next round. Rounds exhausted → fail path of Task 6.

- [ ] **Step 1: Failing scenarios** (group `serve` = `node <fixture>` on a free port, frontend `env {API_URL:"{backend}"}`,
  frontend config `checks: {env: "node -e \"process.exit(process.env.API_URL==='http://localhost:<port>'?0:1)\""}`):
  - `env reaches the frontend checks`: exit 0, integration `group_step` present, integration child's `checks` event ok.
  - `backend fault then pass`: `FAKE_QA_FAIL_INTEGRATION=1 FAKE_GROUP_FAULT=backend` → a `group_step {step:"fix",
    repo:"backend"}`, then a second integration, exit 0.
  - `revised contract rewritten`: `FAKE_GROUP_REVISE=1` with the above → both `contract.md` contain `REVISED`.
  - `rounds exhausted parks both`: `FAKE_QA_FAIL_INTEGRATION=9` → exit 1, both repos at start HEAD.
  - `backend that never answers fails integration`: serve command `node -e "setTimeout(()=>{},1e9)"`, `timeout: 2`
    → the fault prompt (from `FAKE_PROMPTS`) contains `did not answer`; exit 1 after rounds.
  - `no serve skips integration`: covered by Task 6 happy path; assert `skipped` here.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** group tests and `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(group): integration against the running backend and fix rounds`

### Task 8: `orch group rollback`

**Files:** Modify `orch-group.ts`, `orch.ts`; Test `test/group.test.mjs`

**Interfaces:**
- Consumes: group `last-run.json` (Task 6) — on pass it keeps `{checkpoints: Record<role, sha>}` (the start HEADs,
  since the checkpoint branches are dropped); `group-member reset` accepts a sha as well as a branch.
- Produces: `orch group rollback <name>` → locks as in Task 6, `reset` in both, prints parked branches, marks
  `last-run.json` `rolledBack: true`; refuses a second rollback and a failed run (nothing to roll back).

- [ ] **Step 1: Failing scenario** `rollback after pass`: happy path, then rollback → both repos at start HEAD, both
  have `orchestrator/discarded-group-*`; second rollback exits 1.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS (+ `npm test`).
- [ ] **Step 5: Commit** `feat(group): orch group rollback`

### Task 9: Backends and reducer: group events, cost, demux

**Files:**
- Modify: `orch-ui/src/types.ts` (event types), `orch-ui/src/reduce.ts` (`group_child` → `reduce(run, ev.event)`;
  other `group_*` stored on `RunView.group?: { name, contract, step, round, ok? }`)
- Modify: `orch-ui/server.ts` (`COST_EVENTS` also counts `group_plan`; unwrap `group_child.event` before the cost
  check; route `group_child` to the session whose repo equals `event.repo` (normalised path compare, case-insensitive
  on Windows) as if that session's process had printed it)
- Modify: `orch-ui/src-tauri/src/main.rs` (`on_event`: same unwrap, cost and routing)
- Test: `test/unit.test.mjs` (reduce), `test/server.test.mjs` (cost counting of a wrapped `task_end`), Rust unit test
  in `main.rs` for the unwrap helper

**Interfaces:**
- Produces: `unwrapGroupEvent(ev): { repo?: string; ev: OrchEvent }` in `server.ts`; Rust `fn unwrap_group_event(v: &Value) -> (Option<String>, &Value)`.
- Starting a group from the UI is out of scope (UI plan); this task only makes events from a group process, started
  by the backends later, land correctly.

- [ ] **Step 1: Failing tests:** reduce: a `group_child` wrapping `task_start` updates tasks like a bare one;
  `group_plan` sets `run.group.contract`. server: a `group_child{event:{type:"task_end",cost:0.5}}` adds 0.5 to spent.
  Rust: unwrap returns inner event and repo.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS; `cargo fmt`, `cargo clippy --all-targets -- -D warnings`,
  `npm run lint`, `npm run format:check`.
- [ ] **Step 5: Commit** `feat(group): backends and reducer understand group events`

### Task 10: Docs

**Files:** `README.md` (Repo groups section: config example, `orch group add|run|rollback`, env var, limits of v1),
`docs/ARCHITECTURE.md` (event table rows, group state on disk, process diagram text), `CLAUDE.md` (event list,
one Notes bullet), `CHANGELOG.md` `[Unreleased]`, `TODO.md` (UI group page; N repos/other roles; `--on-limit wait`
for groups; PR mode for groups).

- [ ] **Step 1:** Write them. **Step 2:** `npm run format:check`, `npm test` → PASS.
- [ ] **Step 3: Commit** `docs: repo groups`

## Deviations from the spec (for review)

- Usage limit in a group: v1 parks both repos as `interrupted` and exits 3; it does not wait and resume
  (`--on-limit wait` for groups goes to TODO). The spec left the resume mechanics to the builder; this is the simple end.
- The coordinator call runs as a hidden `orch group-member coordinate` child in the backend repo, so it reuses
  `runOnce`, budget, models and swaps without a cwd-free agent runner.
