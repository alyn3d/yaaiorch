# YAAIORCH — Yet Another AI Orchestrator

YAAIORCH turns a goal into working code by looping AI agents until the code passes your checks.
An **architect** agent plans the work, **implementer** agents build it in parallel, the orchestrator
runs your repo's own checks (tests, typecheck, build), and a **QA** agent reviews the result. If
anything fails, the failures go back to the architect and the loop runs again.

It drives the [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) CLI (`claude -p`),
so it uses your existing Claude Code login, agents and skills. It ships as a CLI, a browser UI and a
Windows/macOS/Linux desktop app (Tauri).

> **Status: early (0.1).** It works end to end and is measured by an eval suite, but expect rough
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
| `orch status` | show the queue |
| `orch doctor` | check node, claude login, git, a clean tree, leftover checkpoints |
| `orch rollback` | undo the last unfinished goal (work kept on `orchestrator/discarded-*`) |
| `orch prune` | delete old `orchestrator/*` branches |
| `orch agents` | list the agents and skills the architect can use |

Options: `--power economy|balanced|heavy|max` (heavy), `--model architect=opus,impl=haiku,be=sonnet` (override models per role or per agent), `--on-limit wait|stop` (what to do at the Claude usage limit; default wait for the reset and continue), `--fast` (experimental: try one agent first, full loop only if checks fail), `--max-rounds N` (5), `--max-cost USD`,
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
wait for a free slot. One run per repo at a time. All repos draw on the same Claude usage limit, so
more parallel runs reach it sooner.

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
  { "models": { "architect": "opus", "impl": "haiku", "agents": { "be": "sonnet" } }, "onLimit": "wait" }
  ```

- **Usage limit.** By default a goal that hits the Claude usage limit is set aside, YAAIORCH waits until
  the reset and continues (for `run` and the queue). Choose **Stop** (`--on-limit stop`) to end instead;
  the goal stays pending for later.
- **Checks** come from `.orchestrator/config.json` in your repo, or from the `typecheck`, `lint`,
  `test` and `build` scripts in `package.json`:

  ```json
  { "checks": { "test": "python -m unittest discover -s tests -t ." }, "allow": ["Bash(make lint:*)"] }
  ```

- **Git.** A run refuses a dirty tree, creates `orchestrator/checkpoint-<ts>`, and commits each round
  on your current branch. The checkpoint is deleted when the goal passes. `orch rollback` resets to
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

[MIT](LICENSE). YAAIORCH is an independent project and is not affiliated with Anthropic.
