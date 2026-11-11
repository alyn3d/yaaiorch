# Contributing to YAAIORCH

Thanks for helping. Bug reports, eval cases, agents, docs and code are all welcome. If you are not
sure whether something fits, open an issue first and ask.

## Ways to help

- **Report a bug or a bad run.** Include the goal, the power tier, `orch doctor` output, your OS, and
  the relevant part of the log (`.orchestrator/last-run.json` helps). Remove anything private first.
- **Add an eval case.** The suite in `evals/` is how changes are judged, and more varied cases (other
  languages, frameworks, refactors, multi-file features) make it more useful. See
  [evals/README.md](evals/README.md#adding-a-case). This needs no orchestrator knowledge.
- **Pick an item** from [TODO.md](TODO.md) or [ROADMAP.md](ROADMAP.md). Items marked
  *good first issue* are small and self-contained. Comment on the issue (or open one) so work is not
  duplicated.
- **Improve the docs** if something confused you. That confusion is a bug.

## Setup

Requirements: Node 22.18+, git, Python 3.10+ (for the Python eval cases), and for the desktop app Rust
with the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). You only need Claude Code
installed and logged in for real runs; most work can be tested without spending tokens (see below).

```bash
git clone https://github.com/alyn3d/yaaiorch.git
cd yaaiorch/orch-ui
npm install
```

## Layout

| path | what |
|---|---|
| `orch.ts` | the orchestrator CLI: loop, git handling, limits, events |
| `orch-agents.ts` | built-in agent prompts |
| `orch-ui/src/` | React UI shared by the browser and desktop builds |
| `orch-ui/server.ts` | browser-mode backend (HTTP + SSE) |
| `orch-ui/src-tauri/` | desktop backend (Tauri v2, Rust) |
| `evals/` | eval suite: fixtures, cases, hidden tests, reference solutions, runner |
| `docs/ARCHITECTURE.md` | how it all fits together, the event protocol, data on disk |

[CLAUDE.md](CLAUDE.md) is the short version for AI coding agents working on this repo, and is a good
summary for humans too.

## Checks before you open a PR

Run what your change touches:

```bash
cd orch-ui
npm run build                 # typecheck + build the UI (also typechecks server.ts)
npm run build:orch            # bundle orch.ts; fails on syntax errors
npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --types node --skipLibCheck ../orch.ts
cd src-tauri && cargo check   # if you touched main.rs
cd ../..
node evals/run.ts --reference # if you touched evals/
```

CI runs the same checks on every pull request.

## Testing without spending tokens

Point `CLAUDE_BIN` at a fake `claude` script. It receives the prompt on stdin and must print one JSON
object like the real `claude -p --output-format json`:

```json
{ "type": "result", "subtype": "success", "is_error": false, "result": "…", "total_cost_usd": 0.05 }
```

It must accept `--agents`, `--settings`, `--agent`, `--model`, `--permission-mode` and
`--max-budget-usd`, and answer `--version` and `auth status --json` for `orch doctor`. A fake that
returns a plan for prompts containing "Produce the plan", `{"passed": true, "failures": []}` for
verify prompts, and writes each listed file for build prompts is enough to drive a whole goal.
Committing a ready-made fake plus scenario tests is on the [TODO list](TODO.md) (good first issue).

For a change that affects agent behaviour (prompts, reply formats, power tiers), run a few real eval
cases before and after and put both summaries in the PR:

```bash
node evals/run.ts --cases node-chunk-bug,api-post,py-roman --power economy --repeat 2
```

## Conventions

- **Keep the event protocol in sync.** A new or changed `@@ORCH@@` event must be handled in
  `orch-ui/src/reduce.ts` and documented in `docs/ARCHITECTURE.md`. Both backends pass events through
  unchanged.
- **Keep the backends in sync.** A new action needs a route in `server.ts`, a command in `main.rs` and
  an entry in `transport.ts`. Put the logic in `orch.ts` as a subcommand where you can, so both
  backends only spawn it.
- **Windows first.** Test paths with spaces and backslashes; `claude` runs through a shell on Windows,
  so pass anything complicated through stdin or a file, never as a quoted argument.
- **Trust exit codes and diffs, not agent reports.** New features that judge success should follow
  the same rule.
- Small, focused PRs with a clear description of what changed and how you checked it. Update the
  docs in the same PR.
- Commit messages: imperative summary line, then a short body saying why.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
