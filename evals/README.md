# YAAIORCH evals

Measures how well the orchestrator actually does, so prompt, agent and power-tier changes can be judged
with numbers instead of impressions.

Each run copies a small fixture repo into a fresh git repo under the OS temp dir and runs
`orch run "<goal>"` there. Then the case's **hidden tests** are copied in and its grade command runs.
Agents never see the hidden tests, so a pass means the goal was really met, not only that QA said so.
The grade command also re-runs the fixture's original tests to catch regressions.

## Run

Needs Node 22.18+ (runs `.ts` directly), Python 3.10+ for the `py-*` cases, git, and `npm install` done in
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
| `--power economy,heavy` | economy | tiers to compare |
| `--repeat N` | 1 | runs per case and tier (LLM runs vary; use 3+ for decisions) |
| `--parallel N` | 1 | runs at once |
| `--max-rounds N` | 4 | passed to orch |
| `--max-cost USD` | 3 | passed to orch, per run |
| `--agent-timeout MIN` | 15 | passed to orch |
| `--eval-timeout MIN` | 30 | kills a whole run |
| `--claude-bin PATH` | | a different `claude`, e.g. a fake, to test the runner for free |
| `--orch PATH` | | run a built `orch.mjs` instead of `../orch.ts` |

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

Fixtures have no dependencies, so runs work offline apart from the agents themselves.

## Adding a case

1. Add an entry to `cases.json`: `id`, `fixture`, `kind`, `difficulty`, `goal` (written the way a user
   would ask, with enough detail that the hidden tests are fair), `grade` (a shell command run in the repo
   root; exit 0 means pass; include the fixture's own tests).
2. Put the hidden tests in `hidden/<id>/`, laid out as repo paths (they are copied over the repo).
3. Put a reference solution in `reference/<id>/`, also as repo paths.
4. `node evals/run.ts --reference --cases <id>` must print `ok`.
