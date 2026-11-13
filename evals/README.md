# YAAIORCH evals

Measures how well the orchestrator actually does, so prompt, agent and power-tier changes can be judged
with numbers instead of impressions.

Each run copies a small fixture repo into a fresh git repo under the OS temp dir and runs
`orch run "<goal>"` there. Then the case's **hidden tests** are copied in and its grade command runs.
Agents never see the hidden tests, so a pass means the goal was really met, not only that QA said so.
The grade command also re-runs the fixture's original tests to catch regressions.

## Run

Needs Node 22.18+ (runs `.ts` directly), Python 3.10+ for the `py-*` cases, Go 1.21+ for `go-*`, git, and `npm install` done in
`orch-ui` (the runner starts `../orch.ts` through tsx).

```bash
node evals/run.ts --reference
```

Checks the suite itself, without any agent: for every case the hidden tests must fail on the untouched
fixture and pass with the reference solution in `reference/<id>/`. Run it after changing a case.

```bash
node evals/run.ts --cases node-chunk-bug,api-post --power economy,heavy --parallel 2
```

Runs orch for real (this spends money). Options:

| option | default | meaning |
|---|---|---|
| `--cases a,b` | all | case ids from `cases.json` |
| `--power economy,heavy` | economy | orch configurations to compare (`none` to skip orch): a tier, optionally with `+fast` (`--fast`), `+nomem` (`--no-brief --no-notes`) `+critic` (`--critic`) or `+noresume` (`--no-resume`), combinable, e.g. `economy,economy+nomem` |
| `--single sonnet,opus` | | also run the **control group**: one `claude -p` call per case with this model, the same goal, permissions, check commands and budget |
| `--repeat N` | 1 | runs per case and tier (LLM runs vary; use 3+ for decisions) |
| `--parallel N` | 1 | runs at once |
| `--max-rounds N` | 4 | passed to orch |
| `--max-cost USD` | 3 | passed to orch, per run (per goal in a series) |
| `--agent-timeout MIN` | 15 | passed to orch |
| `--eval-timeout MIN` | 30 | kills a whole run |
| `--claude-bin PATH` | | a different `claude`, e.g. a fake, to test the runner for free |
| `--orch PATH` | | run a built `orch.mjs` instead of `../orch.ts` |
| `--wait-on-limit` | off | on a Claude usage limit, pause until the reset and carry on (for overnight runs) |
| `--resume STAMP` | | finish `results/STAMP.jsonl`: skip recorded runs, drop runs a usage limit spoiled |

A run cut short by the usage limit (orch exits 3) is never recorded. Without `--wait-on-limit` the runner
starts no new runs, writes the summary with an "Stopped early" note and the exact `--resume` command, and
exits 3.

## Head-to-head with a single agent

The question users care about is whether the loop beats simply asking Claude once. `--single` answers it
on the same cases and hidden tests:

```bash
node evals/run.ts --power economy,heavy --single sonnet,opus --repeat 3 --parallel 2
```

The single agent is told the goal and the repo's check commands, may run those commands, gets the same
budget (`--max-budget-usd`) and timeout, and "claims done" when it ends with `Status: COMPLETE`, so
false passes are counted the same way for both. Its rows appear as `single:<model>` in the tables.

## Output

- `results/<stamp>.jsonl`: one line per run: case, power, claimed pass, hidden pass, rounds, cost, seconds,
  stuck events, final power tier, error, work dir.
- `results/<stamp>.md`: tables by power tier (hidden pass rate, claimed pass rate, **false passes**, average
  rounds, cost, time) and by case, plus the grade output of every failure.
- Work dirs stay in `<temp>/yaaiorch-evals/<stamp>/`, each next to its `.orch.log` and `.grade.log`.

`results/` is git-ignored. Commit a summary by hand when it records a decision (for example a new default tier).

**False pass** is the number to watch: the orchestrator reported success but the hidden tests failed. It
means QA or the checks are too lenient.

## Cases

| id | fixture | kind | difficulty |
|---|---|---|---|
| node-slugify | node-lib | feature | easy |
| node-duration | node-lib | feature | medium |
| node-chunk-bug | node-lib | bugfix | easy |
| node-rename | node-lib | refactor | easy |
| node-lru | node-lib | feature | medium |
| node-cli | node-lib | feature | medium |
| api-post | node-api | feature | medium |
| api-delete | node-api | feature | easy |
| py-roman | python-lib | feature | medium |
| py-wordcount-bug | python-lib | bugfix | easy |
| shop-coupons | node-shop | feature | hard: spans cart, pricing, orders and report; rounding and tax order |
| shop-misleading-bug | node-shop | bugfix | medium: symptom in the report, cause in the cart |
| shop-isolated-state | node-shop | refactor | hard: module state into a factory, old API kept |
| api-pagination | node-api | feature | medium: strict validation, header, unsorted seed data |
| node-sortby | node-lib | feature | medium: multi-key stable sort, collation, nulls last |
| py-csv | python-lib | feature | hard: RFC 4180 by hand, error cases |
| go-semver | go-lib | feature | hard: SemVer 2.0 precedence and validation |
| tickets-workflow | node-tickets | feature | long: state machine + history + rule, across service, errors and API |
| tickets-sla | node-tickets | feature | long: business-hours due dates, recompute on priority change, overdue filter |
| tickets-import | node-tickets | feature | long: CSV import, all-or-nothing validation with per-row errors, dedupe |
| shop-refunds | node-shop | feature | long: partial refunds, restock, proportional tax with exact remainder, net report |
| tickets-series | node-tickets | series | 3 goals: tags with validation, tag filter (old tickets without tags), tag stats |
| api-series | node-api | series | 3 goals: create, update and delete, filters |

**Series** cases (`goals` instead of `goal`) run several goals one after another on the same repo, like a
user working through a backlog, and are graded once at the end with hidden tests covering every goal. A
later goal builds on the earlier ones, so this is where the project brief and the notes between goals
(`.orchestrator/brief.md`, `notes.md`) should pay off: compare `--power economy,economy+nomem` on them. Their
rounds and cost are totals over the goals, and a series counts as claimed only if every goal passed. The
single-agent control runs one call per goal, with no memory in between.

```bash
node evals/run.ts --cases tickets-series,api-series --power economy,economy+nomem --repeat 3
```

The `long` cases are meant to be more than one model call can comfortably hold: several dependent
changes across layers in one goal. They are where the loop should beat the single-agent control.

Fixtures have no dependencies (Go 1.21+ for `go-lib`), so runs work offline apart from the agents
themselves. Fixtures with non-npm checks carry them in `.orchestrator/config.json`, which is
git-ignored elsewhere, so add it with `git add -f`.

## Adding a case

1. Add an entry to `cases.json`: `id`, `fixture`, `kind`, `difficulty`, `goal` (written the way a user
   would ask, with enough detail that the hidden tests are fair; or `goals`, a list, for a series), `grade` (a shell command run in the repo
   root; exit 0 means pass; include the fixture's own tests).
2. Put the hidden tests in `hidden/<id>/`, laid out as repo paths (they are copied over the repo).
3. Put a reference solution in `reference/<id>/`, also as repo paths.
4. `node evals/run.ts --reference --cases <id>` must print `ok`.
