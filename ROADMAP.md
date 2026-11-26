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
- read-only planner and QA, and a Windows desktop app;
- one goal across a backend and a frontend repo, built against a shared contract and checked live together.

Its remaining gaps: no sandbox for untrusted repos (more pressing now that agents can run commands you approve),
Claude Code as the only agent runtime, and eval cases hard enough to need more than one round. The first eval
results are published ([November 2026](docs/evals/2026-11-18.md)): every run passed, and one direct attempt matched
the full loop at about half the cost, so it is the default. Parallel build tasks can use opt-in Git worktrees.

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

## 0.3: reliability and trust (released 0.3.0)

Make it boring to run unattended, and prove it with tests.

Shipped in 0.3.0: a fake `claude` with scenario, server and unit tests in CI (no tokens); a run lock per
repo, safe queue edits and atomic state files; plan path checks; retries of transient API errors; a loop
budget; a report of files changed outside the plan; a protected browser-mode server; stop after the current
goal. Ahead of schedule from 0.4: the project brief and `orch learn`, notes between goals, context between
rounds, per-task escalation and an optional plan critic (built, not yet measured), and series eval cases to
measure them.

Still open, moved to the next release:

- A full eval baseline across tiers, a default tier chosen from it, and the numbers published (pass
  rate, false passes, cost per tier): the claim "measured" needs public data.
- Measuring the 0.4 features above on the series cases before they stay on by default.
- Lint and format in CI, and spawning `claude` without a shell on Windows (both done).

## 0.4: better results per dollar, and whole projects (released 0.4.0)

Shipped in 0.4.0: session resume for fix rounds, a diff critic and a review lens, tidied notes and `orch share`
(a CLAUDE.md section), lint and format in CI, `claude` without a shell on Windows. From 0.5, ahead of
schedule: a branch and a pull request per goal (one per brief), a plan approval gate, notifications, goal
dependencies with retries and blocked goals. New: big briefs (`orch split`, the **Big brief** box), new
projects (`orch new`, **+ New project**), dependency setup, a queue budget and progress.

Still open, moved to the next release:

- Measuring the 0.3 and 0.4 features on the eval cases (series, greenfield, multi-round) before they stay on
  by default, and a full baseline across tiers with the numbers published.

## 0.5: autonomy (released 0.5.0)

From "run this goal" to "work through this backlog".

Shipped across 0.4.0 and 0.5.0: a branch and a pull request per goal (one per brief), goals from labelled GitHub
issues or `BACKLOG.md` with dependencies and priorities, retries and blocked goals, comments on the issue, the
pull request's CI watched and fixed, a plan approval gate, notifications, protected paths and a secret scan.
Parallel build tasks can optionally run in separate worktrees, with task diffs applied back and conflicted worktrees
preserved for recovery. Overview also has a cross-repo work board for active tasks, human input, PR review and
completed queue goals. 0.5.5 added Agent M (agents run shell commands only after you allow each one, and a chat
about your setup and repos), made the direct attempt the default after the first published evals, and fixed the
desktop app finding `claude` on macOS and Linux.

Still open, moved on:

- Optional sandboxed runs (container or VM) for repos you do not fully trust the agents with.
- A GitHub Action that runs orch on a labelled issue in CI, and optional auto-merge after CI and a human review.
- Running the issue and CI flows against real GitHub, and measuring all of 0.3 to 0.5 on the evals. The fast path is
  measured; memory, resume and the critics need harder cases first (today's all pass in round 1).

## 0.6: repo groups (released 0.6.0)

One goal across more than one repo.

Shipped in 0.6.0: repo groups of one backend and one frontend repo. A coordinator writes the API contract and a goal
per repo, both repos build in parallel against it (the other repo readable, never writable), then the frontend is
checked against the running backend: its agents call the backend through a probe tool limited to it, and a case not
checked live fails the check. A failed integration goes back to the side at fault; on failure both repos are reset and
the work parked, and a passed goal can be rolled back in both. Groups have a page in the app (define, run, approve the
contract, stop, roll back), and member repos show their part. Skills and custom agents can be turned off per repo.

Still open, moved on:

- More than two repos and other roles (several backends, a shared library, a mobile app).
- Watching a group's pull requests' CI and fixing it. (A branch and pull request per repo, group eval cases and waiting
  out a usage limit inside a group shipped in 0.6.4.)

## 0.7: product and packaging

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
