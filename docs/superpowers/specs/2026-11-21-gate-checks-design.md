# Gate-only checks and fix-round eval cases

Status: draft, 2026-11-21.

## Why

Every eval case passes in round 1, so the features that only act in a fix round cannot be measured: session resume,
per-task escalation, `previousRound()` context, the diff critic and the review lens (TODO.md, 0.4 "Measure these").
The two `multi-round` cases (`api-patch-contract`, `lib-retry-lint`) were built to fail a first attempt through house
rules in the repo's own checks. All 7 measured runs passed in round 1 anyway.

Cause: `writeAgentSettings` (orch.ts) puts every check command on the agents' allow-list, and `directPlan` tells the
dev agent it may run them. The agent runs the checks, sees the failure, and fixes it in the same session. Round 1
absorbs every failure the checks can show.

So a case can force a fix round only through a failure the gate catches and the agent cannot see during its session.
Real projects have such checks: slow end-to-end, integration or performance suites that run in CI, not on the
developer's machine. orch has no way to express them.

## Goals

- A config key for **gate-only checks**: orch runs them after the round like the other checks, and a failure fails
  the round, but they are not on the agents' allow-list.
- Eval cases where a careful first attempt usually passes the ordinary checks and fails the gate, so round 2 happens
  for most runs.
- With those cases, measure the fix-round features (`economy`, `+noresume`, `+diffcritic`, `+review`, per-task
  escalation) with `--repeat 3`.

## Non-goals

- Breaking a single context (big fixtures, backlogs, `--single` head-to-head). That is the next step (TODO "Repo-scale
  cases"), not this one.
- Hiding checks from humans: the gate is in the config, the UI and the event stream like any check.
- Sandboxing. An agent with `--commands` can ask Agent M to run the gate command; that is the human's call.

## Anti-goals

- Cases that fail for reasons unrelated to the goal (flaky tests, timeouts, environment). A fix round must be
  about the work, or it measures noise.
- Cases whose gate a fix round cannot pass either. A gate failure must carry enough output for an agent to fix it.
- Changing orch's behaviour for repos without `gateChecks`.

## Approaches considered

1. **Gate-only checks (chosen).** A config key; orch runs the commands, agents may not. Forces round 2 by design.
   Useful outside the evals (expensive suites agents should not burn time on). Costs a small orch feature.
2. **Checks agents cannot run in practice**, with no orch change: a suite longer than the agent's Bash timeout, or
   one that needs the dev server. Depends on Claude Code's timeouts; brittle across versions.
3. **Requirements only QA catches**: gaps a careful review finds. Measures QA strictness, not fix rounds; QA almost
   never failed a round in the November runs.

## Design

### orch

- **Config** `gateChecks: Record<string, string>` in `.orchestrator/config.json`, same shape as `checks`. No CLI flag.
  No package.json fallback: gate checks are always explicit.
- **Order:** after the ordinary checks (and setup), only when all of them passed. Gate suites are slow by intent, and
  a failing unit test is the thing to fix first. When skipped, the round report says so.
- **Failure** is a check failure: it fails the round, goes into `checkFailures`, `failureKey` (stuck detection),
  `previousRound()` and `checkReport`, the same way an ordinary check does. `verifiedBy` counts gate checks as checks.
- **Allow-list:** `writeAgentSettings` leaves gate commands out. If an ordinary check's allow rule would also match a
  gate command (`Bash(node --test:*)` matches `node --test test/gate/...`), orch warns at start and `orch doctor`
  reports it as a warning. (Claude Code rules are prefix matches on the command.)
- **Prompts:** agents are told gate checks exist, by name, and that they cannot run them: "After the build the
  orchestrator also runs gate checks you cannot run yourself: perf, integration. Their failures, if any, come back
  in the next round." The architect, the dev agent (`directPlan`), `orch learn` and fix rounds get this line. The
  command is not hidden (it is in the config) but not offered.
- **Fast path:** unchanged. A gate failure fails round 1 and falls back to the full loop, which is the fix round.
- **Event:** the existing `checks` event; each result gets `gate: true`. A skipped gate gets `ok: null, skipped: true`
  (or is left out; builder's call, but the UI must show that it did not run).
- **UI:** the checks row marks gate checks ("gate") and shows skipped ones. `reduce.ts` keeps the field;
  `server.ts`, `main.rs` pass events through and need no change (to verify). The run settings page lists gate checks
  next to checks if it lists checks today.
- **doctor:** lists gate checks; warns on allow-rule overlap.
- **Tests:** a scenario (fake claude) where the ordinary checks pass, the gate fails in round 1 and passes in round 2;
  one where an ordinary check fails and the gate is skipped; a unit test that `writeAgentSettings` omits gate
  commands, and of the overlap warning.
- **Docs:** README (config), ARCHITECTURE (checks), CLAUDE.md (one line), CHANGELOG `[Unreleased]`.

### Eval cases

Three cases to start, each with a gate suite whose failures a first attempt usually hits and a fix round can act on.
Kind `multi-round`. Candidate themes (builder may substitute if a theme does not discriminate):

1. **Performance budget.** A feature over a collection; visible tests use small inputs; the gate runs it on 100k
   items under a time budget an O(n^2) solution misses and an O(n log n) one meets with a wide margin (no flakiness
   on a slow CI machine: at least 10x headroom).
2. **Property/fuzz gate.** A parser or date/range function; the gate runs seeded randomized inputs (fixed seed,
   deterministic) against invariants (round trip, ordering, boundaries) and prints the smallest failing input.
3. **Integration gate.** A multi-layer feature on `node-tickets`; the gate drives the HTTP API end to end through a
   sequence (create, transition, list, export) where a gap between layers shows only in combination.

Per case: `cases.json` entry (with a `gate` command, run from the gate copy's directory), fixture changes (or a new
fixture), the gate suite in `evals/gate/<id>/` (outside the repo, see "Decided by the user"), hidden tests (grade =
hidden + fixture tests + gate), reference.

**Runner:** `--reference` additionally checks that the gate fails on the fixture and passes with the reference.
Results already record rounds; add a column "reached round 2" (share of runs with rounds >= 2) to the summary, since
that is what tells whether a case does its job.

### Validation and measurement

1. `--reference` ok for all three.
2. Discrimination run: `--power economy --repeat 3` on the three cases. A case is kept if at least 2 of 3 runs
   reach round 2 and the reference passes. Otherwise rework it.
3. Measurement run: `--power economy,economy+noresume,economy+diffcritic,economy+review --repeat 3`. Publish
   `docs/evals/<date>.md`, update TODO.md "Measure these".

Both runs spend money; the user starts them or approves them first.

## Calls made after the builder check

- **Tampering:** grading always copies the pristine gate suite over the repo first (like the hidden tests), so a
  weakened gate cannot make a run pass. orch reads `gateChecks` once at run start (not refreshed per round like
  `checks`), so editing the config mid-run does not change the gate. A case whose gate files sit in the repo also lists
  them in its fixture's `protect`, so changing them fails the round.
- **Discrimination run** uses `economy` (the full loop, the config being measured), not `economy+fast`.
- **Per-task escalation:** no new switch. It only fires on a stuck round, which a fixed gate failure does not cause.
  The summary reports how often stuck rounds and escalation happened (the jsonl already records stuck events and the
  final tier). Gate output avoids timings in failure lines (perf gate prints input size and pass/fail, not ms), and
  `failureKey` ignores numbers anyway.

## Decided by the user

- **Gate suites live outside the eval repo** (the user's pick, 2026-11-21), like integration tests in another repo or
  CI job. A suite in the repo would likely be read and satisfied in round 1, as happened with the house-rule cases.
  - Source: `evals/gate/<id>/`, next to `hidden/` and `reference/`.
  - Per run, the runner copies it to a sibling of the work dir (`<run dir>/<id>.gate/`, never inside the repo) and
    merges `gateChecks` with that absolute path into the repo's `.orchestrator/config.json` (git-ignored, written
    after the fixture's own config is copied). The fixture's committed config keeps only `checks`.
  - Headless agents cannot read outside the repo: reads there need a permission prompt, which `-p` refuses. The
    prompt names the gate checks but not where they live.
  - Grading runs the pristine `evals/gate/<id>/` copy, so it is never the agents' (they cannot reach it anyway).
  - `--reference`: gate fails on the fixture, passes with the reference.
  - The `protect` call above is moot for these cases; it stays a recommendation for real repos that keep a gate
    suite in-tree.

## Left to the builder

- Exact prompt wording; event field for skipped gates; how the UI marks gate checks.
- Case content within the three themes, as long as the discrimination run passes.
