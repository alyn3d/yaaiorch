<p align="center"><img src="docs/assets/logo-256.png" alt="YAAIORCH logo" width="128" height="128"></p>

# YAAIORCH — Yet Another AI Orchestrator

YAAIORCH turns a goal into working code by looping AI agents until the code passes your checks.
An **architect** agent plans the work, **implementer** agents build it in parallel, the orchestrator
runs your repo's own checks (tests, typecheck, build), and a **QA** agent reviews the result. If
anything fails, the failures go back to the architect and the loop runs again.

It drives the [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) CLI (`claude -p`),
so it uses your existing Claude Code login, agents and skills. It ships as a CLI, a browser UI and a
Windows/macOS/Linux desktop app (Tauri).

> **Status: early (0.3).** It works end to end and is measured by an eval suite, but expect rough
> edges. Windows is the primary target; Linux and macOS should work but are less tested.
> Contributions are very welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

```
goal ──► architect ──► foundation ──► build (parallel) ──► checks ──► QA
             ▲                                                        │
             └──────────── failures (next round) ◄────────────────────┘
```

## Why another one?

- **It trusts evidence, not reports.** A task that claims success without changing its files is
  re-run. Your repo's checks run in the orchestrator itself, and a non-zero exit fails the round no
  matter what QA says.
- **It is safe to leave running.** Every goal starts from a git checkpoint and is committed round by
  round. Rollback is one command (or button), and nothing is ever thrown away: discarded work is
  kept on a branch. There is a budget per goal, a timeout per agent, stuck detection that moves up a
  model tier or stops, and a queue that waits out Claude usage limits.
- **It is measured.** `evals/` grades real runs with hidden tests the agents never see, per power
  tier, including "false passes" (the orchestrator said done but the code is wrong).
- **Least privilege.** The architect and QA run read-only; implementers can only edit, plus run the
  repo's check commands.

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) installed and logged in (`claude --version`, `claude auth status`)
- Node.js 22.18+ (Node 20 works for the orchestrator itself; the eval runner needs 22.18+)
- git (strongly recommended: checkpoints, commits, rollback)
- For the desktop app: Rust (MSVC toolchain on Windows) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

**Cost:** every run calls Claude models. A small goal costs roughly $0.30 on the `economy` tier and
$0.60–0.90 on `balanced`/`heavy` (measured on the eval suite). Use `--max-cost` to cap a goal.

## Download

Installers for Windows (`.exe` setup or `.msi`), macOS and Linux, and a standalone CLI bundle
(`yaaiorch-cli-<version>.mjs`, run with `node`), are on the
[releases page](https://github.com/alyn3d/yaaiorch/releases), with SHA-256 checksums.

- The apps are **not code-signed** yet: Windows SmartScreen shows "Windows protected your PC"
  (choose *More info* → *Run anyway*), and macOS needs right-click → *Open* the first time.
- The desktop app runs the orchestrator with your **Node.js** (20+, on PATH) and your logged-in
  **Claude Code**; it does not bundle either.

## Quick start (from source)

```bash
git clone https://github.com/alyn3d/yaaiorch.git
cd yaaiorch/orch-ui
npm install
npm run build:orch      # bundles ../orch.ts into one file: src-tauri/resources/orch.mjs
```

### CLI

Make `orch` point at the bundle:

```bash
alias orch="node /path/to/yaaiorch/orch-ui/src-tauri/resources/orch.mjs"
```

In PowerShell: `function orch { node C:\path\to\yaaiorch\orch-ui\src-tauri\resources\orch.mjs @args }`.
(While hacking on YAAIORCH itself, run the source instead: `node orch-ui/node_modules/tsx/dist/cli.mjs orch.ts`.)

Then, from the root of the repo you want to change (it must have a clean git working tree):

```bash
orch doctor
orch run "Add a /health endpoint that returns {ok: true}, with a test" --power economy --max-cost 2
```

Other commands:

| command | what it does |
|---|---|
| `orch run "<goal>"` | one goal, loops until QA passes or max rounds |
| `orch add "<goal>"` / `orch loop` | queue goals and process them (`--until-empty` to stop when drained) |
| `orch stop-after` | a running `loop` stops before its next goal (the current one finishes) |
| `orch status` | show the queue |
| `orch doctor` | check node, claude login, git, a clean tree, leftover checkpoints |
| `orch rollback` | undo the last unfinished goal (work kept on `orchestrator/discarded-*`) |
| `orch prune` | delete old `orchestrator/*` branches |
| `orch agents` | list the agents and skills the architect can use |
| `orch learn` | study the repo once (read-only) and write the project brief that later goals reuse |
| `orch plugins [--details]` | list your Claude Code plugins (with `--details`: context tokens each adds per call) |

Options: `--power economy|balanced|heavy|max` (heavy), `--model architect=opus,impl=haiku,be=sonnet` (override models per role or per agent), `--on-limit wait|stop` (what to do at the Claude usage limit; default wait for the reset and continue), `--usage-cap 5h=80,week=90` (pause before reaching the limit: at that percentage of the 5-hour or weekly window), `--plugins off` / `--disable-plugins ID,ID` / `--no-hooks` (run agents without your Claude Code plugins or hooks), `--no-brief` (do not keep a project brief), `--no-resume` (fix rounds start every implementer cold), `--approve-plan` (wait for you to build, edit or send back each plan), `--branch` (each goal on its own `orch/<id>-<slug>` branch; yours never changes), `--pr` (push a passed goal's branch and open a pull request with `gh`), `--strict-files` (a file changed outside the plan fails the round), `--max-cost-total USD` (budget for a whole `loop` run), `--no-notes` (do not keep lessons between goals), `--critic` (review each plan before building), `--diff-critic` (also review each round's change against the goal), `--review` / `--reviewers A,B` (review each change for bugs and security, optionally with your own agents), `--fast` (experimental: try one agent first, full loop only if checks fail), `--max-rounds N` (5), `--max-cost USD`,
`--agent-timeout MIN` (30), `--dry-run` (plan only). Run `orch` without arguments for the full usage.

### Browser UI

```bash
cd orch-ui
npm run build
ORCH_REPO=/path/to/your/repo npm start      # http://localhost:4317
```

On Windows `cmd`: `set "ORCH_REPO=C:\path\to\repo" && npm start`. Open more repos with **+ Repo** in the
UI (or `ORCH_REPOS`, separated by `;` on Windows and `:` elsewhere); they are remembered.

### Several repos at once

Both the browser UI and the desktop app work on several repos in parallel: one **tab per repo**, each
with its own goal, queue, settings and log, and a status dot (running, waiting, failed, done). The
**Parallel** field in the header limits how many repos run at the same time (default 2); further starts
wait for a free slot. With two or more repos open, an **Overview** tab lists them all: what each is doing
(planning, building, verifying), its goal, round, tasks, cost and queue, with Open and Stop. One run per repo at a time. All repos draw on the same Claude usage limit, so
more parallel runs reach it sooner.

- **Usage limit, shared.** When one repo hits the Claude usage limit, a banner shows the reset time and
  new runs in every repo wait until then (running ones wait on their own). **Try now** starts them early.
- **Daily $** sets a spending cap for all repos together, per day. Each run's max cost is capped to what
  is left; when it is used up, new runs wait for the next day and a queue stops before its next goal.
  Today's spend is shown next to it and kept across restarts. Runs that start at the same time can
  overshoot the cap by up to one run's cost.
- **Usage %.** The header shows how much of your Claude subscription's **5-hour** and **weekly** limits is
  used (read from each agent call). Under **Limits** you can set **Pause at 5h %** and **Pause at week %**:
  at that point new runs wait and running goals pause before their next agent call until the window
  resets (or stop, with the usage-limit setting on **Stop**). This keeps headroom for your own Claude use.
  It needs a Claude subscription login (API keys report no usage), and a call already running can go a
  little past the cap. Daily $ and the % caps can be used together.

### Desktop app

```bash
cd orch-ui
npm run tauri dev       # development window
npm run tauri build     # installers in src-tauri/target/release/bundle
```

Pick the target repo with **Choose repo…**. The app needs Node on PATH at runtime.

## How it works

- **Agents.** Built-in `architect`, `fe`, `be` and `qa` live in [`orch-agents.ts`](orch-agents.ts).
  Agents in `~/.claude/agents` and your repo's `.claude/agents` are discovered too and override
  built-ins with the same name, so you can bring your own specialists.
- **Plans** are JSON: tasks with a phase (`foundation`, `build`, `verify`) and the files each task owns.
  No file is owned twice, which is what makes parallel builds in one working tree safe.
- **Models.** Each power tier maps the roles (architect, implementers, heavy tasks, QA, fast-path agent)
  to models. Override any role, or a single agent, with `--model` or in `.orchestrator/config.json`;
  aliases (`haiku`, `sonnet`, `opus`) or full model IDs. In the UI: the **Models** section.

  ```json
  { "models": { "architect": "opus", "impl": "haiku", "agents": { "be": "sonnet" } }, "onLimit": "wait", "usageCap": { "5h": 80, "week": 90 } }
  ```

- **Learning the repo once.** A short project brief (`.orchestrator/brief.md`: stack, layout, conventions,
  commands) is written on the first run, or up front with **Learn repo** / `orch learn`, and every later
  round and goal, and every agent in it, reuses it instead of exploring the repo again. When many files
  have changed since it was written, the next goal's architect checks and corrects it. Fix rounds also see
  what the previous round planned, how each task ended and what changed, and a stuck round with one
  failing task moves only that task's agent up a tier. Lessons from earlier goals (QA's notes, what failed)
  go into `.orchestrator/notes.md`, which the architect reads before planning.
- **Plan critic** (optional, **Plan critic** in the run settings or `--critic`): a read-only agent reviews
  each plan before anything is built; a rejected plan goes back to the architect once. One extra call per
  round.
- **Diff reviews** (optional): **Diff critic** (`--diff-critic`) has the critic check each round's change
  against the goal, and **Review lens** (`--review`) has a reviewer check it for bugs and security
  problems, the built-in one or your own agents (`--reviewers security-reviewer,backend-reviewer`). They run
  next to QA, as independent opinions, and a rejection fails the round; when a check already failed they are
  skipped. One extra call each per round.
- **New projects** (`orch new DIR "<spec>"`, or `--spec-file SPEC.md`): creates the folder with git, `SPEC.md` and a
  `.gitignore`, uses the spec as the first project brief, and has the architect split it into queued goals (the
  scaffold first, then one goal per feature) with suggested checks in `.orchestrator/config.json`. Nothing is
  built until you run `orch loop --until-empty` there, so you can review the queue and the checks first. Checks
  are read again every round, so a `package.json` written in round 1 is already checked in round 1.
- **Installing dependencies** (`"setup": "npm install"` in `.orchestrator/config.json`, or `orch new --setup`):
  agents never install packages; they add them to the manifest, and orch runs your setup command before the
  checks whenever a manifest or lock file changed. Folders it creates that git does not ignore (`node_modules/`,
  `.venv/`) are kept out of git. The command runs packages' install scripts with your rights, so use it only for
  projects you would install yourself (`npm install --ignore-scripts` is safer).
- **Notifications** (**Notify** in the header, off until you turn it on): a desktop notification when a goal
  passes or fails, a plan waits for your approval, or a run waits for the usage limit or your usage cap, only
  while the window is not in front. The desktop app uses the system's notifications; the browser asks for
  permission when you turn it on.
- **Plan approval** (optional, **Approve plans** in the run settings, `--approve-plan`): after planning, the
  run waits for you. The run panel shows the plan with **Build it**, **Edit plan** (as JSON, checked before it
  is used) and **Send back** with a reason, which the architect plans again with. In a terminal: `orch approve`,
  `orch approve --reject "why"`, or edit `.orchestrator/plan-pending.json` and `orch approve --plan-stdin <` it.
- **A branch and a pull request per goal** (optional, **Branch per goal** / **Open pull request** in the run
  settings, `--branch` / `--pr`): each goal runs on its own `orch/<id>-<slug>` branch and orch switches back
  afterwards, so your branch is never changed. With `--pr`, a passed goal's branch is pushed to `origin` and
  a pull request is opened with the GitHub CLI (`gh`, logged in); you review PRs, not runs. A missing `gh` or
  remote is reported, and the branch stays for you.
- **Tidy notes and share them.** When `notes.md` grows past 5,000 characters, one cheap call merges and prunes
  it. `orch share` (**Share to CLAUDE.md**) turns the brief and lasting lessons into a section of the repo's
  `CLAUDE.md`, committed on an `orchestrator/claude-md-*` branch for you to review and merge, so teammates and
  their own Claude sessions get it too; your working tree is not touched.
- **Plugins.** Agents are ordinary `claude -p` calls, so by default they load your Claude Code plugins
  and hooks, and every plugin adds context (cost) to every agent call; some, like prompt-style or
  "always use skills" plugins, also change how agents behave. In the UI, **Plugins** (in each repo's run
  settings) lists them with the tokens each adds, with a switch per plugin, one for all, and one for
  hooks. CLI: `--plugins off`, `--disable-plugins caveman@caveman`, `--no-hooks`, or
  `"plugins": {"off": true, "disable": [...], "hooks": false}` in config. Your Claude Code setup itself is
  not changed: orch passes the choice in the agents' own `--settings` file.
- **Usage limit.** By default a goal that hits the Claude usage limit is set aside, YAAIORCH waits until
  the reset and continues (for `run` and the queue). Choose **Stop** (`--on-limit stop`) to end instead;
  the goal stays pending for later.
- **Checks** come from `.orchestrator/config.json` in your repo, or from the `typecheck`, `lint`,
  `test` and `build` scripts in `package.json`:

  ```json
  { "checks": { "test": "python -m unittest discover -s tests -t ." }, "allow": ["Bash(make lint:*)"] }
  ```

- **Git.** A run refuses a dirty tree, creates `orchestrator/checkpoint-<ts>`, and commits each round
  on your current branch. The checkpoint is deleted when the goal passes and all its work is committed; if a commit fails (a
  rejecting hook, say), the checkpoint is kept and the run tells you. `orch rollback` resets to
  it. State lives in `.orchestrator/` in your repo and is never committed.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety notes

YAAIORCH runs AI agents that **edit files and run commands in your repo**. Implementers run with
Claude Code's `acceptEdits` permission mode plus an allow-list for your check commands; the architect
and QA run in `default` mode with edit tools denied. Run it on a repo you have committed or pushed,
review the commits before you push them, and set `--max-cost`. Do not point it at a repo that holds
secrets you would not show to the model.

## Evals

```bash
node evals/run.ts --reference                          # checks the suite itself, no agents, free
node evals/run.ts --cases node-chunk-bug --power economy   # real run, costs money
```

10 cases over three small fixture repos (Node library, Node API, Python), graded by hidden tests.
See [evals/README.md](evals/README.md).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for where this is going and [TODO.md](TODO.md) for the task list.
Good first issues are marked there.

## Contributing

Contributions are welcome: bug reports, eval cases, agents, docs and code. Read
[CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and please follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 alyn3d and contributors.

YAAIORCH is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License version 3](LICENSE) (GPL-3.0-only), as published by the Free Software
Foundation. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; see the
license for details.

Releases up to and including 0.2.0 were published under the MIT License, and those copies stay
available under it; later versions are GPL-3.0.

YAAIORCH is an independent project and is not affiliated with Anthropic.
