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
  (`test/unit.test.mjs`); `reduce.ts` still has none. **good first issue**
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

## 0.4: better results per dollar

Each item should show its effect in the evals before it becomes the default.

- [x] **Plan critic** (seen in LoopDex and oh-my-claudecode): after the architect, a read-only `critic`
  agent reviews the plan against the goal and the repo and returns `{approved, issues[]}`; issues go back
  to the architect once. It sees only artifacts (goal, plan, file list), never the architect's
  reasoning. Behind a flag first (`--critic`), compared with and without on the eval suite.
- [ ] **Diff critic**: the same agent reviews the diff before QA, so QA and the critic are independent
  opinions; a failed check still wins over both.
- [x] **Project brief**: the architect writes `.orchestrator/brief.md` once (stack, conventions,
  commands) and later rounds and goals reuse it instead of re-reading the repo.
- [x] **Context between rounds**: give the architect its previous plan, the diff and the check output,
  not only the failure strings.
- [ ] **Session resume for fix rounds**: continue the implementer's session (`session_id` from the CLI)
  instead of starting cold.
- [x] **Memory between goals**: `.orchestrator/notes.md` with decisions and pitfalls, read by the
  architect, appended by QA.
- [ ] **Review lens**: optional reviewer pass on the diff for bugs and security, with the user's own
  reviewer agents when present.
- [x] **Escalate per task**: on a stuck round, move only the failing tasks up a tier.
- [x] **Learn the repo**: `orch learn` / **Learn repo** writes the brief up front; implementers and QA get
  the brief and recent notes too; a brief stamped at an old commit (20+ changed files) is checked again.
- [ ] **Tidy the notes**: when `notes.md` gets long, one cheap call merges duplicates and drops lessons that
  no longer apply, instead of cutting the oldest.
- [ ] **Share what was learned**: optionally propose the brief and lasting lessons as a section of the
  repo's CLAUDE.md, as a commit to review, so teammates and fresh clones get it.
- [x] **Cases to measure them with**: two series cases (`tickets-series`, `api-series`: three goals in a row
  on one repo) and runner configs `+nomem` and `+critic`.
- [ ] **Measure these** (brief, notes, context between rounds, per-task escalation, plan critic): they were built
  without an eval, because the current cases all pass in round 1. Needs cases that take several
  rounds and a multi-goal case; then compare with `--no-brief` and the old behaviour.

## 0.5: autonomy

- [ ] **Branch and pull request per goal**: run each goal on `orch/<id>-<slug>`, finish with
  `gh pr create`, never touch the main branch.
- [ ] **Backlog intake**: read goals from `BACKLOG.md` or GitHub issues with a label; priority and
  `dependsOn` on queue items.
- [ ] **Queue lifecycle**: show the running goal, retry policy, a `blocked` status for goals that need a
  human, per-item power and max rounds.
- [ ] **Plan approval gate**: optional pause after planning so a human can approve or edit the plan.
- [ ] **Worktree per build task** so parallel agents cannot break each other's test runs (Conductor,
  Baton and others isolate this way). Merge back after the phase; exclusive file ownership keeps it
  conflict-free.
- [ ] **Sandboxed runs** (optional): run the agents in a container or VM for repos you do not fully
  trust them with.
- [ ] **Notifications** when a goal finishes, fails or waits (desktop notification in Tauri).

## 0.6: product and packaging

- [ ] **Run history**: append events to `.orchestrator/runs/<id>.jsonl`, list and replay past runs.
- [ ] **Per-task output** on the task cards (truncated report in `task_end`), and a diff viewer per round.
- [ ] **Token counts** next to cost.
- [ ] **Agent roster page**: view and edit agents, show discovered skills.
- [ ] **Per-repo settings** (power, max rounds, budget) remembered by the desktop app.
- [ ] **One backend**: share line parsing and event buffering instead of keeping `server.ts` and
  `main.rs` in sync (or let the desktop app start `server.ts`).
- [ ] **Shared event types** between `orch.ts` and the UI (one discriminated union). **good first issue**
- [ ] **More agent runtimes**: put Codex CLI, Gemini CLI and OpenCode behind the `run()` contract
  (prompt in, `{text, cost}` out, permission mode mapped per runtime), choosable per role, and add
  `--runtime` to the eval runner to compare them.
- [ ] **Packaging**: bundle Node as a sidecar, sign the Windows installer, auto-update, release builds
  for Windows, macOS and Linux from CI.
- [ ] **Verify on macOS and Linux** (CLI, browser mode, desktop build). **good first issue** if you
  have the machine.
