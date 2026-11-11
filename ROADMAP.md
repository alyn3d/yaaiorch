# YAAIORCH roadmap

YAAIORCH should become a loop you can hand a backlog to and trust overnight: it plans, builds, checks
and opens pull requests, spends a known amount, stops when it is stuck, and never loses work. Each
milestone below moves toward that; the detailed task list is in [TODO.md](TODO.md).

## Principles

- **Evidence over reports.** Success is decided by diffs, exit codes and hidden tests, never by what an
  agent says about its own work.
- **Measure before changing defaults.** Prompt, agent and tier changes go through the eval suite.
- **Never lose work.** Every destructive git step keeps what it replaces on a branch.
- **Least privilege.** Roles get only the permissions they need.
- **Bring your own agents.** Built-in agents are a starting point; user and project agents override them.

## 0.1: working loop (done)

The architect → foundation → parallel build → checks → QA loop, queue, power tiers, built-in agents,
git checkpoints with commits per round, rollback and prune, budget and timeouts, stuck detection,
read-only planner and QA, usage-limit handling, `orch doctor`, browser UI and Windows desktop app, and
an eval suite graded by hidden tests. See [CHANGELOG.md](CHANGELOG.md).

## 0.2: reliability and trust

Make it boring to run unattended, and prove it with tests.

- A full eval baseline across tiers, and a default tier chosen from it.
- Harder eval cases, since the first ones are too easy to tell the tiers apart.
- A committed fake `claude` and cross-platform scenario tests in CI, so contributors can change the
  loop without spending tokens.
- Hardening: browser-mode CSRF protection, queue locking, retrying transient failures, budget per loop
  session, graceful stop, enforced file ownership.

## 0.3: better results per dollar

Fewer rounds and cheaper rounds for the same pass rate, each change backed by eval numbers.

- A project brief reused across rounds and goals.
- Richer context for fix rounds (previous plan, diff, check output) and resumed implementer sessions.
- Memory between goals, an optional review lens, and per-task escalation.

## 0.4: autonomy

From "run this goal" to "work through this backlog".

- A branch and a pull request per goal; humans review PRs, not runs.
- Goals from `BACKLOG.md` or labelled GitHub issues, with priorities and dependencies.
- Queue lifecycle (retry policy, `blocked` goals), an optional plan approval gate, notifications.
- Worktrees per build task for real isolation between parallel agents.

## 0.5: product and packaging

- Run history and replay, per-task output, diff viewer, token counts, agent roster editor.
- One backend instead of two in sync.
- Installers for Windows, macOS and Linux built in CI, with Node bundled and auto-update.

## Later ideas

Open for discussion in issues; not committed to:

- Other agent runtimes or model providers behind the same `run()` contract.
- A shared, versioned library of agents and eval cases.
- Running goals on remote machines or in containers.
