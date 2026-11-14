# YAAIORCH tasks

Open work, grouped by milestone (see [ROADMAP.md](ROADMAP.md) for the why). Items marked
**good first issue** are small and self-contained. Want one? Open an issue or comment on the existing
one so nobody duplicates work. Finished work is listed in [CHANGELOG.md](CHANGELOG.md).

## 0.3: reliability and trust (0.3.0 released; open items carry over)

### Measure
- [ ] **Finish the baseline.** Run the whole eval suite on all four tiers with `--repeat 3`
  (`--parallel 2 --max-rounds 3 --max-cost 3 --wait-on-limit`) and choose the default power tier from
  the data. A first partial run (21 runs) passed everything; economy cost about $0.30 a run,
  balanced $0.65, heavy $0.85. Publish the summary in `docs/evals/` and link it from the README:
  other orchestrators mostly show star counts, so public pass-rate and false-pass numbers are a
  differentiator.
- [x] 7 harder cases (multi-file feature, misleading bug, state refactor, pagination, multi-key sort,
  RFC 4180 CSV, SemVer in Go) and a single-agent control group (`--single`).
- [x] 4 long-horizon cases (`tickets-workflow`, `tickets-sla`, `tickets-import`, `shop-refunds`) on a
  new layered fixture (`node-tickets`).
- Head-to-head so far (hidden-test pass, avg cost, avg time per case):

  | cases | orch economy | single Sonnet call |
  |---|---|---|
  | 7 hard, 1 run each | 7/7, $0.35, 1.5 min | 7/7, $0.24, 0.7 min |
  | 4 long, 2 runs each | 8/8, $0.44, 2.5 min | 8/8, $0.40, 1.6 min |

  No false passes on either side; the loop always finished in one round. Up to multi-file, multi-layer
  features, one Sonnet call is enough, and the loop's cost overhead shrinks as tasks grow (+45% to
  +10%) but it does not yet win on pass rate.
- [ ] **Repo-scale cases**, where a single context should break down: a whole small app from a spec
  (15+ files), a goal that is really a backlog of 4-6 dependent features, a migration across a larger
  fixture (2,000+ lines), and a task where the first attempt reliably fails the checks. Repeat the
  head-to-head with `--repeat 3` and harder single-agent models (Opus) too. **good first issue**
  (one case per PR)
- [ ] **Fast path** (now well supported by data): when the plan is a single build task, skip the
  separate verify call and rely on the orchestrator's checks plus a cheap review, to reach single-call
  cost and time on small goals while keeping git safety, limits and the checks.
- [ ] **Cheaper path for small goals**: if the evals keep showing a single call is enough for small
  tasks, let the architect answer "single task" plans that skip the separate verify call, or add a
  `--fast` mode, and measure it.

### Test the orchestrator itself
- [x] Fake `claude` (`test/fake-claude/`) and 47 scenario tests (`npm test`), run in CI on Linux and
  Windows; the Rust spawn test is `#[ignore]`d and run explicitly in CI.
- [x] **More scenarios**: phantom completion and its re-dispatch, foundation failure skipping the
  round, a commit hook that fails (done); still open: a pre-existing `.orchestrator/config.json` allow-list reaching the
  agents, `--wait-on-limit` and `--resume` in the eval runner. **good first issue**
- [x] **Unit tests** for `validate`, `extractJson`, `parseReset`, `failureKey`, `badPath` and more in `orch.ts`
  (`test/unit.test.mjs`), and the UI's `reduce.ts`, `progress.ts` and `notifyText.ts`.
- [x] **Lint and format**: ESLint + Prettier for TS, `rustfmt` + `clippy` for Rust, wired into CI.
  **good first issue**

### Correctness and safety
- [x] **Local CSRF in browser mode.** `server.ts` now refuses a foreign `Host` or `Origin` and requires a
  per-process session token on every `/api` call (`test/server.test.mjs`).
- [x] **Queue write races.** (queue edits under a lock, atomic writes, a run lock per repo) The UI's `add` and the loop both read-modify-write `queue.json`. Use a
  lock file, or route every write through one process, and write through a temp file + rename.
- [x] **Retry transient failures** once (network errors, API overload), separately from the usage limit.
- [x] **Budget per loop session**, not only per goal (`--max-cost-total`).
- [x] **Graceful "stop after current goal"** (`orch stop-after`, UI button) for `loop` from the UI (a stop file checked between
  goals). Today Stop kills the process tree.
- [x] **Ownership enforcement**: after the build phase, files changed outside every task's list go to QA,
  and fail the round with `--strict-files`.
- [x] **Spawn `claude` without a shell on Windows** (resolve the executable once) to drop the
  `DEP0190` warning and the quoting risk (`claude-bin.ts`).

## 0.4: better results per dollar (0.4.0 released; measuring carries over)

Each item should show its effect in the evals before it becomes the default.

- [x] **Plan critic** (seen in LoopDex and oh-my-claudecode): after the architect, a read-only `critic`
  agent reviews the plan against the goal and the repo and returns `{approved, issues[]}`; issues go back
  to the architect once. It sees only artifacts (goal, plan, file list), never the architect's
  reasoning. Behind a flag first (`--critic`), compared with and without on the eval suite.
- [x] **Diff critic**: the same agent reviews the diff before QA, so QA and the critic are independent
  opinions; a failed check still wins over both (`--diff-critic`; runs next to QA, skipped when a check failed).
- [x] **Project brief**: the architect writes `.orchestrator/brief.md` once (stack, conventions,
  commands) and later rounds and goals reuse it instead of re-reading the repo.
- [x] **Context between rounds**: give the architect its previous plan, the diff and the check output,
  not only the failure strings.
- [x] **Session resume for fix rounds**: continue the implementer's session (`session_id` from the CLI)
  instead of starting cold (`--no-resume` to turn off; not measured yet: compare `economy` with `economy+noresume`).
- [x] **Memory between goals**: `.orchestrator/notes.md` with decisions and pitfalls, read by the
  architect, appended by QA.
- [x] **Review lens**: optional reviewer pass on the diff for bugs and security, with the user's own
  reviewer agents when present (`--review`, `--reviewers A,B`).
- [x] **Escalate per task**: on a stuck round, move only the failing tasks up a tier.
- [x] **Learn the repo**: `orch learn` / **Learn repo** writes the brief up front; implementers and QA get
  the brief and recent notes too; a brief stamped at an old commit (20+ changed files) is checked again.
- [x] **Tidy the notes**: when `notes.md` gets long (past 5000 characters), one cheap call merges duplicates and drops lessons that
  no longer apply, instead of cutting the oldest.
- [x] **Share what was learned** (`orch share`, **Share to CLAUDE.md**): optionally propose the brief and lasting lessons as a section of the
  repo's CLAUDE.md, as a commit to review, so teammates and fresh clones get it.
- [x] **Cases to measure them with**: two series cases (`tickets-series`, `api-series`: three goals in a row
  on one repo) and runner configs `+nomem` and `+critic`.
- [ ] **Measure these** (brief, notes, context between rounds, per-task escalation, session resume, plan and diff
  critic, review lens; configs `+nomem`, `+noresume`, `+critic`, `+diffcritic`, `+review`): they were built
  without an eval, because the current cases all pass in round 1. Needs cases that take several
  rounds and a multi-goal case; then compare with `--no-brief` and the old behaviour.

## 0.5: autonomy (0.5.0 released; worktrees and sandboxing carry over)

- [x] **Branch and pull request per goal**: run each goal on `orch/<id>-<slug>`, finish with
  `gh pr create`, never touch the main branch (`--branch`, `--pr`).
- [x] **Backlog intake**: goals from GitHub issues with a label (`orch intake --github`, `loop --intake`, **Import
  issues**) or `BACKLOG.md`; a PR closes its issue. `dependsOn` came with big briefs. Priority labels (`p1`-`p9`,
  `priority: high`) and comments on the issue (start, done, failed, blocked) came next.
- [x] **Queue lifecycle**: retry policy (`--retries`, a tier up), a `blocked` status for goals that need a failed
  one, dependencies between goals of a brief, `orch retry` / **Retry**, per-item power on retry. Still open:
  per-item max rounds set by hand.
- [x] **Plan approval gate**: optional pause after planning so a human can approve or edit the plan
  (`--approve-plan`, `orch approve`, the run panel).
- [ ] **Worktree per build task** so parallel agents cannot break each other's test runs (Conductor,
  Baton and others isolate this way). Merge back after the phase; exclusive file ownership keeps it
  conflict-free.
- [ ] **Sandboxed runs** (optional): run the agents in a container or VM for repos you do not fully
  trust them with.
- [x] **Notifications** when a goal finishes, fails or waits (desktop notification in Tauri; the browser's in
  browser mode; **Notify** in the header).

## Greenfield

- [x] **`orch new DIR "<spec>"`**: git, SPEC.md, the spec as brief, goals queued, checks suggested.
- [x] **Checks read every round**, so files the agents create are checked; **`setup`** installs on manifest change.
- [x] **Eval case** `greenfield-inventory` (empty repo, scaffold goal, feature goal).
- [x] **Big briefs**: `orch split`, the **Big brief** box (edit the split, queue, queue and start), spec.md for every
  architect, a coverage check when the queue runs dry.
- [x] **New project in the UI**: **+ New project** (parent folder, name, spec, setup, power, budget, start) runs
  `orch new` in a new tab.
- [x] **Budget and progress** for a whole queue: **Budget $** (`--max-cost-total`) in the UI, the brief's progress
  (done, failed, blocked, cost, time left) above the queue and in the overview.
- [x] **Multi-round eval cases**: `api-patch-contract`, `lib-retry-lint` (house rules only the checks enforce).
- [ ] **Measure** `orch new` on a few specs (pass rate of the hidden tests, cost, rounds).

## Issue to merged PR

- [x] **Fix the PR's CI**: wait for `gh pr checks`, run fix goals with the failing logs on the PR branch, push.
- [x] **Talk on the issue** (start, done, failed, blocked) and **priority labels**.
- [ ] A GitHub Action that runs orch on a labelled issue in CI, so no local machine is needed.
- [ ] Optional auto-merge once CI and a human review pass.

## Safety

- [x] **Protected paths** (`protect`, default `.github/workflows/`): rejected in plans, reverted if changed anyway.
- [x] **Secret scan** before every commit: known key formats, private keys, `.env` files.
- [ ] A scan for licenses or large binaries added by agents; a size limit per round.

## Browser checks for QA

- [x] **Phase 1**: config `serve`, `visual` pages on verify tasks, dev server lifecycle, CDP capture with the
  installed Chrome/Edge (screenshots, page and console errors, failed requests, overflow, CLS), problems fail the
  round, `orch browser login|install`, doctor, the run view's **Browser** row.
- [ ] **Screenshots in the UI**: thumbnails per round (desktop: asset protocol scoped to `.orchestrator/visual`;
  browser mode: a guarded `/api` route), and a **Browser login** button that runs `orch browser login`.
- [ ] **`serve` in the run settings**, so it need not be written into config.json by hand.
- [ ] **Design comparison**: a Figma link or images in the goal; export the frames and give QA both.
- [ ] **Refute pass**: a fresh read-only agent tries to disprove each QA or review failure before it fails the
  round (fewer wasted rounds); measure false fails on the evals.
- [x] **Eval cases** `web-dashboard-bug` and `web-pricing`, graded in a browser; `+novisual` to compare.
- [ ] **Measure** them: `--power economy,economy+novisual --repeat 3`, and decide whether browser checks are worth
  their cost by default.
- [ ] **Baseline**: capture the checkpoint's pages too, so observations that predate the goal are labelled as such.

## 0.6: product and packaging

- [ ] **Run history**: append events to `.orchestrator/runs/<id>.jsonl`, list and replay past runs.
- [x] **Per-task output** on the task cards (truncated report in `task_end`), and a diff viewer per round.
- [x] **Token counts** next to cost in live and persisted run summaries, rounds, tasks, planning and reviews.
- [x] **Agent roster page**: view built-in, user-level and project agents plus discovered skills; edit
  project agents or save repo-local overrides without changing global Claude Code definitions.
- [x] **Per-repo settings** (power, max rounds, budget) remembered by the desktop app.
- [ ] **One backend**: share line parsing and event buffering instead of keeping `server.ts` and
  `main.rs` in sync (or let the desktop app start `server.ts`).
- [ ] **Shared event types** between `orch.ts` and the UI (one discriminated union). **good first issue**
- [ ] **More agent runtimes**: put Codex CLI, Gemini CLI and OpenCode behind the `run()` contract
  (prompt in, `{text, cost}` out, permission mode mapped per runtime), choosable per role, and add
  `--runtime` to the eval runner to compare them.
- [ ] **Packaging**: bundle Node as a sidecar (done: `fetch-node.mjs`, Tauri externalBin), sign the Windows installer, auto-update, release builds
  for Windows, macOS and Linux from CI.
- [ ] **Verify on macOS and Linux** (CLI, browser mode, desktop build). **good first issue** if you
  have the machine.
