# YAAIORCH tasks

Open work, grouped by milestone (see [ROADMAP.md](ROADMAP.md) for the why). Items marked
**good first issue** are small and self-contained. Want one? Open an issue or comment on the existing
one so nobody duplicates work. Finished work is listed in [CHANGELOG.md](CHANGELOG.md).

## 0.2: reliability and trust

### Measure
- [ ] **Finish the baseline.** Run the whole eval suite on all four tiers with `--repeat 3`
  (`--parallel 2 --max-rounds 3 --max-cost 3 --wait-on-limit`) and choose the default power tier from
  the data. A first partial run (21 runs) passed everything; economy cost about $0.30 a run,
  balanced $0.65, heavy $0.85. Publish the summary in `docs/evals/` and link it from the README:
  other orchestrators mostly show star counts, so public pass-rate and false-pass numbers are a
  differentiator.
- [x] 7 harder cases (multi-file feature, misleading bug, state refactor, pagination, multi-key sort,
  RFC 4180 CSV, SemVer in Go) and a single-agent control group (`--single`).
- [ ] **Longer-horizon cases.** First head-to-head (7 hard cases, 1 run each): orch economy 7/7 at
  $0.35 and 1.5 min per case; a single Sonnet call 7/7 at $0.24 and 0.7 min. On tasks this size the
  loop adds cost, not pass rate. Its advantage should show on work one call cannot hold: features
  spanning many files and layers, several dependent changes in one goal, larger fixture repos, and
  tasks whose first attempt usually fails checks. Build those next, then repeat the head-to-head with
  `--repeat 3`. **good first issue** (one case per PR)
- [ ] **Cheaper path for small goals**: if the evals keep showing a single call is enough for small
  tasks, let the architect answer "single task" plans that skip the separate verify call, or add a
  `--fast` mode, and measure it.

### Test the orchestrator itself
- [x] Fake `claude` (`test/fake-claude/`) and 16 scenario tests (`npm test`), run in CI on Linux and
  Windows; the Rust spawn test is `#[ignore]`d and run explicitly in CI.
- [ ] **More scenarios**: phantom completion and its re-dispatch, foundation failure skipping the
  round, a commit hook that fails, a pre-existing `.orchestrator/config.json` allow-list reaching the
  agents, `--wait-on-limit` and `--resume` in the eval runner. **good first issue**
- [ ] **Unit tests** for `reduce.ts`, and for `validate`, `extractJson`, `parseReset`, `failureKey`
  in `orch.ts` (export them or split helpers into a module). **good first issue**
- [ ] **Lint and format**: ESLint + Prettier for TS, `rustfmt` + `clippy` for Rust, wired into CI.
  **good first issue**

### Correctness and safety
- [ ] **Local CSRF in browser mode.** `server.ts` accepts any request on localhost and parses JSON
  without checking `Origin` or `Content-Type`, so a web page could POST `/api/run`. Add an
  Origin/Host check and a per-session token. **good first issue**
- [ ] **Queue write races.** The UI's `add` and the loop both read-modify-write `queue.json`. Use a
  lock file, or route every write through one process, and write through a temp file + rename.
- [ ] **Retry transient failures** once (network errors, API overload), separately from the usage limit.
- [ ] **Budget per loop session**, not only per goal (`--max-cost-total`).
- [ ] **Graceful "stop after current goal"** for `loop` from the UI (a stop file checked between
  goals). Today Stop kills the process tree.
- [ ] **Ownership enforcement**: after the build phase, report files changed outside every task's
  owned list to QA as a failure.
- [ ] **Spawn `claude` without a shell on Windows** (resolve the executable once) to drop the
  `DEP0190` warning and the quoting risk.

## 0.3: better results per dollar

Each item should show its effect in the evals before it becomes the default.

- [ ] **Plan critic** (seen in LoopDex and oh-my-claudecode): after the architect, a read-only `critic`
  agent reviews the plan against the goal and the repo and returns `{approved, issues[]}`; issues go back
  to the architect once. It sees only artifacts (goal, plan, file list), never the architect's
  reasoning. Behind a flag first (`--critic`), compared with and without on the eval suite.
- [ ] **Diff critic**: the same agent reviews the diff before QA, so QA and the critic are independent
  opinions; a failed check still wins over both.
- [ ] **Project brief**: the architect writes `.orchestrator/brief.md` once (stack, conventions,
  commands) and later rounds and goals reuse it instead of re-reading the repo.
- [ ] **Context between rounds**: give the architect its previous plan, the diff and the check output,
  not only the failure strings.
- [ ] **Session resume for fix rounds**: continue the implementer's session (`session_id` from the CLI)
  instead of starting cold.
- [ ] **Memory between goals**: `.orchestrator/notes.md` with decisions and pitfalls, read by the
  architect, appended by QA.
- [ ] **Review lens**: optional reviewer pass on the diff for bugs and security, with the user's own
  reviewer agents when present.
- [ ] **Escalate per task**: on a stuck round, move only the failing tasks up a tier.

## 0.4: autonomy

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

## 0.5: product and packaging

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
