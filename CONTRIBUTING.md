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
npm test                      # scenario tests with the fake claude
npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --types node --skipLibCheck ../orch.ts
cd src-tauri && cargo check   # if you touched main.rs
cd ../..
node evals/run.ts --reference # if you touched evals/
```

CI runs the same checks on every pull request.

## Testing without spending tokens

```bash
cd orch-ui
npm test        # scenario tests: real orch.ts, fake claude, throwaway git repos (~40 s)
```

`test/scenarios.test.mjs` runs `orch` end to end against [`test/fake-claude/`](test/fake-claude/fake-claude.mjs),
a stand-in for `claude -p --output-format json` that never calls a model. The scenarios cover the
happy path, plan retry, a crashing or hanging agent, failed checks beating QA, the budget cap, stuck
escalation, rollback, loop parking, the usage limit in `run` and `loop`, prune, doctor and input
validation. Set `KEEP_TEST_REPOS=1` to keep the temp repos for inspection.

The fake is controlled with environment variables (`FAKE_QA`, `FAKE_FAIL_AGENT`, `FAKE_HANG_AGENT`,
`FAKE_NOWRITE`, `FAKE_COST`, `FAKE_LIMIT_ON`, …, documented at the top of the file). To try `orch` by
hand with it:

```bash
CLAUDE_BIN=/path/to/yaaiorch/test/fake-claude/claude orch run "anything"        # POSIX
set "CLAUDE_BIN=C:\path\to\yaaiorch\test\fake-claude\claude.cmd" && orch run "anything"   # Windows cmd
```

New behaviour in the loop should come with a scenario. The desktop backend has its own spawn test,
run with the same fake: `TEST_REPO=<empty dir> ORCH_PATH=<orch.mjs> CLAUDE_BIN=<fake> cargo test -- --ignored`.

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

## Releasing (maintainers)

1. Set the version in `orch-ui/package.json`, `orch-ui/src-tauri/Cargo.toml` and
   `orch-ui/src-tauri/tauri.conf.json`, and run `npm install --package-lock-only` and `cargo check` so the
   lock files follow.
2. Move the `[Unreleased]` notes in `CHANGELOG.md` under the new version with today's date, and update
   the compare links at the bottom.
3. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
4. The **Release** workflow builds Windows, macOS and Linux installers, attaches them with the CLI
   bundle and `SHA256SUMS.txt` to a **draft** release. Check the draft, then publish it.

## License

YAAIORCH is licensed under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only). By contributing
you agree that your contributions are licensed under the same terms.
