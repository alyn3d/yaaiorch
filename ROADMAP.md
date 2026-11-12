# YAAIORCH roadmap

YAAIORCH should become a loop you can hand a backlog to and trust overnight: it plans, builds, checks
and opens pull requests, spends a known amount, stops when it is stuck, and never loses work. Each
milestone below moves toward that; the detailed task list is in [TODO.md](TODO.md).

## Where it stands (November 2026)

Compared with other open-source loops and orchestrators (LoopDex, Lodeloop, Ralph-style loops,
oh-my-claudecode, claude-flow/ruflo, SWE-AF, Claude Code agent teams, and session managers such as
Conductor, Claude Squad and Vibe Kanban), YAAIORCH's distinct strengths are:

- the loop is deterministic code, not an LLM coordinating other LLMs;
- success is decided by exit codes, diffs and hidden-test evals with a false-pass count;
- it never loses work, and has a budget, timeouts, stuck escalation and usage-limit waiting;
- read-only planner and QA, and a Windows desktop app.

Its gaps, addressed below: no isolation between parallel agents (others use worktrees or sandboxes),
no GitHub issue-to-pull-request flow, no critic that reviews the plan before building, Claude Code as
the only agent runtime, and no published numbers yet.

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

## 0.2: several repos and cost control (done)

Run several repos at once from one UI and keep spending under control: a tab per repo with a parallel
limit and an Overview tab, one shared usage-limit hold, a daily budget and percentage caps on the
5-hour and weekly usage windows, model choice per role and agent, a switch per Claude Code plugin for
the agents, and safer git and budget handling (no lost checkpoint after a failed commit, parallel
agents share the budget). See [CHANGELOG.md](CHANGELOG.md).

## 0.3: reliability and trust

Make it boring to run unattended, and prove it with tests.

- A full eval baseline across tiers, a default tier chosen from it, and the numbers published (pass
  rate, false passes, cost per tier): the claim "measured" needs public data.
- Harder eval cases, since the first ones are too easy to tell the tiers apart.
- A committed fake `claude` and cross-platform scenario tests in CI, so contributors can change the
  loop without spending tokens.
- Hardening: browser-mode CSRF protection, queue locking, retrying transient failures, budget per loop
  session, graceful stop, enforced file ownership.

## 0.4: better results per dollar

Fewer rounds and cheaper rounds for the same pass rate, each change backed by eval numbers.

- A plan critic: a separate read-only agent reviews the plan (and later the diff) before work goes on,
  seeing only artifacts (plan, diff, check output), never the other agents' reasoning.
- A project brief reused across rounds and goals.
- Richer context for fix rounds (previous plan, diff, check output) and resumed implementer sessions.
- Memory between goals, an optional review lens, and per-task escalation.

## 0.5: autonomy

From "run this goal" to "work through this backlog".

- A branch and a pull request per goal; humans review PRs, not runs.
- Goals from `BACKLOG.md` or labelled GitHub issues, with priorities and dependencies.
- Queue lifecycle (retry policy, `blocked` goals), an optional plan approval gate, notifications.
- Worktrees per build task (or per goal) for real isolation between parallel agents, and optional
  sandboxed runs (container or VM) for repos you do not fully trust the agents with.

## 0.6: product and packaging

- Run history and replay, per-task output, diff viewer, token counts, agent roster editor.
- One backend instead of two in sync.
- More agent runtimes behind the same `run()` contract (Codex CLI, Gemini CLI, OpenCode), so roles can
  mix providers and the evals can compare them.
- Installers for Windows, macOS and Linux built in CI, with Node bundled and auto-update.

## Later ideas

Open for discussion in issues; not committed to:

- A shared, versioned library of agents and eval cases.
- Using Claude Code's native agent teams for a build phase, if the evals show it beats separate processes.
- Running goals on remote machines or in containers.
