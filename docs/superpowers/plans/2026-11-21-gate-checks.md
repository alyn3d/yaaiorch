# Gate-only Checks and Fix-Round Eval Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gateChecks` (checks orch runs but agents cannot), and three eval cases whose gate suites live outside the
repo so most runs need a fix round.

**Architecture:** `orch.ts` reads `gateChecks` once per run, keeps them off the agents' allow-list, runs them after the
ordinary checks pass and treats a failure like any check failure. The UI marks gate results. `evals/run.ts` copies each
case's gate suite from `evals/gate/<id>/` next to the work dir and writes `gateChecks` into the repo config before the
fixture commit; grading uses the pristine suite.

**Tech Stack:** TypeScript (Node 22.18+, run through tsx), React UI (`orch-ui/src`), `node:test`, fake claude.

**Spec:** `docs/superpowers/specs/2026-11-21-gate-checks-design.md`

## Global Constraints

- Repos without `gateChecks` behave exactly as before (no new prompt text, no new event fields).
- Gate commands never appear in `agent-settings.json` / `readonly-settings.json` allow lists.
- Gate checks run only when every ordinary check (and setup) passed in that round.
- `gateChecks` is read once at run start; not refreshed per round.
- Agents are told gate check **names** only, never commands or paths.
- Gate output in eval cases carries no timings in failure lines.
- Event changes keep `server.ts`, `main.rs`, `reduce.ts` in sync (the `checks` event is passed through unchanged by both backends; verify, do not assume).
- Prettier printWidth 160; `npm run lint`, `npm run format:check`, `npm test` pass (run in `orch-ui`).
- CHANGELOG `[Unreleased]` entry in the same change; no personal data, local paths or eval results committed.
- `--reference` and real eval runs: `--reference` is free; any run without `--claude-bin` fake spends money and needs the user's go-ahead.

## Review Focus

1. **Allow-rule prefix overlap** (`checks: {test: "node --test"}`, gate `node --test ../x.gate/`): agents could run the gate. Expect a warning at run start and a doctor `warn`. Test in Task 1.
2. **`checks.test` adds `npm test`** to the allow list: a gate `npm test -- --gate` overlaps through it. Overlap must consider `npm test` too. Test in Task 1.
3. **Gate configured but no ordinary checks**: gate runs (nothing to fail first), and the fast path's "judged by checks" still counts the gate as a check (`verifiedBy`). Test in Task 2.
4. **Invalid `gateChecks`** (array, non-string command, empty name): run refuses with a clear error at start, not a crash mid-round. Test in Task 1.
5. **Gate failure output on the next round**: architect's fix round must see the gate failure text (via `checkFailures` / `previousRound`), else round 2 is blind. Test in Task 2.

---

### Task 1: Gate config, allow-list exclusion, overlap warning, doctor

**Files:**
- Modify: `orch.ts` (`Config` type ~line 750, after `loadChecks` ~line 904, `writeAgentSettings` caller at run start ~line 4933, doctor ~line 3738, exports at bottom)
- Test: `test/unit.test.mjs`, `test/scenarios.test.mjs`

**Interfaces:**
- Produces:
  - `Config.gateChecks?: Record<string, string>`
  - `loadGateChecks(cfg: Config): Record<string, string>`: `{}` when absent; throws `Error('config "gateChecks" must be an object of name: command strings')` on a non-object, array, empty name or non-string/empty command.
  - `gateOverlap(checks: Record<string, string>, gate: Record<string, string>): string[]`: gate names whose command starts with an ordinary check command or, when `checks.test` exists, with `npm test`.
  - Both exported at the bottom of `orch.ts`.

- [ ] **Step 1: Write failing unit tests** in `test/unit.test.mjs`:
  - `loadGateChecks({})` → `{}`; `loadGateChecks({gateChecks: {perf: "node perf.js"}})` → same object.
  - `loadGateChecks({gateChecks: ["x"]})`, `{gateChecks: {perf: 3}}`, `{gateChecks: {"": "x"}}`, `{gateChecks: {perf: " "}}` each throw `/gateChecks/`.
  - `gateOverlap({test: "node --test"}, {gate: "node --test ../g/x.test.js"})` → `["gate"]`.
  - `gateOverlap({test: "npm run test"}, {gate: "npm test -- --gate"})` → `["gate"]` (via `npm test`).
  - `gateOverlap({lint: "npm run lint"}, {gate: "node ../g/run.mjs"})` → `[]`.
- [ ] **Step 2:** Run `cd orch-ui && node --test ../test/unit.test.mjs`. Expected: FAIL, functions not exported.
- [ ] **Step 3:** Implement `loadGateChecks` and `gateOverlap` next to `loadChecks`. Export them.
- [ ] **Step 4: Write failing scenario** `"gate checks stay off the agents' allow-list; an overlapping check rule is warned about"` in `test/scenarios.test.mjs`:
  - Repo A: `{checks: {unit: 'node -e "0"'}, gateChecks: {perf: 'node -e "1"'}}`, `orch(dir, ["run", "x", "--max-rounds", "1"])`. Both settings files: an allow entry `Bash(node -e "0":*)`, none containing `node -e "1"`. Output does not match `/gate check "perf"/`.
  - Repo B: `{checks: {unit: 'node -e "0"'}, gateChecks: {perf: 'node -e "0" && node -e "1"'}}`. Output matches `/warning: gate check "perf" starts with an ordinary check command/`.
  - Repo C: `{gateChecks: ["x"]}`: `code` non-zero, output matches `/gateChecks/`.
- [ ] **Step 5:** At run start (where `let checks = loadChecks(cfg)` is), add `const gate = loadGateChecks(cfg);` and, for each name in `gateOverlap(checks, gate)`, `console.log(\`warning: gate check "${name}" starts with an ordinary check command, so agents can run it; give it a distinct command\`)`. `writeAgentSettings` is unchanged (it only ever receives `checks`); `refreshChecks` keeps recomputing overlap-free settings from `checks` only.
- [ ] **Step 6:** Doctor: after the `checks` finding, push `{name: "gate checks", level: overlap.length ? "warn" : "ok", detail: ...}` only when `gateChecks` has entries (names, plus `"agents can run: <names>"` on overlap); `level: "fail"` with the message when `loadGateChecks` throws. Add a unit or scenario assertion on `orch doctor --json` for the overlap case.
- [ ] **Step 7:** Run `cd orch-ui && npm test`. Expected: all pass.
- [ ] **Step 8: Commit** `feat(orch): gateChecks config, kept off the agents' allow-list`

### Task 2: Run gate checks in the round, report them, tell agents

**Files:**
- Modify: `orch.ts`: `Check` type (line 803), round check block (~5290-5300), `checkFailures` (~5388), `checkReport` (~1025), module-level `GATE_HINT` next to `VISUAL_HINT` (line 373) and its use in `makePlan` (~3991), `directPlan` (4018), learn prompt (~4143)
- Test: `test/scenarios.test.mjs`

**Interfaces:**
- Consumes: `loadGateChecks`, the `gate` const from Task 1.
- Produces:
  - `Check.gate?: true`
  - `checks` event: each result may carry `gate: true`; event gains `gateSkipped?: string[]` (gate names not run because an ordinary check failed). Both omitted when no gate is configured.
  - `gateHint(names: string[]): string`: `""` for none, else `" After the build the orchestrator also runs gate checks you cannot run yourself: <names joined by \", \">. Their failures, if any, come back in the next round."` Exported.
  - `directPlan(goal, checks, brief, notes, gateNames: string[] = [])`.

- [ ] **Step 1: Write failing scenario** `"a gate check failure fails round 1 and is fixed in round 2"`:
  - Gate command: `node -e` script that fails on its first run and passes after, keyed on a counter file outside the repo (`${dir}.gate-count`), printing `gate: 1 case failed: sorted output` on failure.
  - Config `{checks: {unit: 'node -e "0"'}, gateChecks: {perf: <that command>}}`; `orch(dir, ["run", "x", "--max-rounds", "3"])`.
  - Assert: `code === 0`; first `checks` event results `[["unit", true, undefined], ["perf", false, true]]` as `[name, ok, gate]`; round 1 `round_end.failures` has `/check "perf" failed/`; round 2 passes.
  - With `FAKE_PROMPTS=<dir>.prompts`: the round-2 architect prompt contains `gate: 1 case failed` (gate output reaches the fix round); the round-1 architect prompt contains `gate checks you cannot run yourself: perf` and does **not** contain the gate command text.
- [ ] **Step 2: Write failing scenario** `"gate checks are skipped while an ordinary check fails"`: ordinary check exits 1, gate would pass; `--max-rounds 1`; `checks` event has no `perf` result and `gateSkipped: ["perf"]`; `round_end.failures` has no `perf`.
- [ ] **Step 3: Write failing scenario** `"fast path with only a gate check falls back on gate failure"`: config only `gateChecks` (fails once, as in Step 1), `["run", "x", "--fast", "--max-rounds", "3"]`; modes `["direct", "full"]`, `code === 0`; the dev agent's prompt contains `gate checks you cannot run yourself`.
- [ ] **Step 4:** Run `cd orch-ui && node --test --test-name-pattern gate ../test/scenarios.test.mjs`. Expected: FAIL.
- [ ] **Step 5:** Implement in the round block: after `runChecks(checks)`, if every result so far is ok and the gate is non-empty, append `runChecks(gate).map((c) => ({...c, gate: true}))`; else, when the gate is non-empty, `gateSkipped = Object.keys(gate)`. Emit `gate` per result and `gateSkipped` only when set. `checkFailures` and `verifiedBy` need no change beyond seeing gate results in `checkResults`. In `checkReport`, label gate results `(gate check, agents cannot run it)`.
- [ ] **Step 6:** Implement `gateHint`; set `GATE_HINT = gateHint(Object.keys(gate))` at run start and add it to `makePlan`'s base after `VISUAL_HINT`; pass `Object.keys(gate)` into `directPlan` and append `gateHint` to its task text; add it to the learn prompt after the checks list.
- [ ] **Step 7:** Run `cd orch-ui && npm test`. Expected: all pass (existing scenarios unchanged, Global Constraint 1).
- [ ] **Step 8: Commit** `feat(orch): run gate checks after the ordinary checks; failures drive the fix round`

### Task 3: UI, backends, docs

**Files:**
- Modify: `orch-ui/src/types.ts` (line 134), `orch-ui/src/reduce.ts` (line 264), `orch-ui/src/RunView.tsx` (~550), `orch-ui/src/runProgress.ts` (line 122 failure text), `orch-ui/server.ts` / `orch-ui/src-tauri/src/main.rs` (verify only)
- Modify docs: `README.md` (config section under "How it works"), `docs/ARCHITECTURE.md` (checks step + event table `checks` row), `CLAUDE.md` (one Notes line), `CHANGELOG.md` `[Unreleased]` Added
- Test: `test/unit.test.mjs` (reduce)

**Interfaces:**
- Consumes: `checks` event fields `gate`, `gateSkipped` from Task 2.
- Produces: `RoundView.checks[i].gate?: boolean`, `RoundView.gateSkipped?: string[]`.

- [ ] **Step 1: Write failing reduce test:** folding a `checks` event with `results: [{name: "perf", ok: false, gate: true, ...}]` and `gateSkipped: ["e2e"]` keeps `gate` on the result and `gateSkipped` on the round.
- [ ] **Step 2:** Run unit tests. Expected: FAIL on `gateSkipped`.
- [ ] **Step 3:** Types + reduce: `checks: ev.results, gateSkipped: ev.gateSkipped`.
- [ ] **Step 4:** RunView: gate badges show `gate · <name>`; skipped gate names render as `badge` with class `skipped` (reuse an existing muted badge class if one exists) and title `not run: an earlier check failed`. runProgress failure text says `Gate check "<name>" failed` for gate results.
- [ ] **Step 5:** Confirm `server.ts` and `main.rs` pass `checks` through without whitelisting fields (grep `"checks"` in both). If either copies fields, add `gate` / `gateSkipped`.
- [ ] **Step 6:** Docs. README: `"gateChecks": {"perf": "node ../perf-gate.mjs"}`: run after the checks pass, agents cannot run them, use a command that does not start with an ordinary check's. ARCHITECTURE: same, plus event fields. CLAUDE.md Notes line: `Gate checks (config gateChecks, loadGateChecks, read once): run after the checks pass, never on the agents' allow-list (gateOverlap warns), names only in prompts (gateHint); checks event gate / gateSkipped.` CHANGELOG Added entry.
- [ ] **Step 7:** `cd orch-ui && npm run build && npm run lint && npm run format:check && npm test`. Expected: all pass.
- [ ] **Step 8: Commit** `feat(ui): show gate checks; docs`

### Task 4: Eval runner support for gate suites

**Files:**
- Modify: `evals/run.ts` (`Case` type line 44, `setupRepo` 191, `grade` 222, `--reference` 233, `checksIn` 361 unchanged, summary ~637), `evals/README.md`

**Interfaces:**
- Produces:
  - `Case.gate?: string`: a shell command with `{gate}` placeholder for the gate suite directory, run with cwd = repo.
  - `Case.grade` may contain `{gate}` too.
  - `gateDir(dir: string, c: Case): string` = `${dir}.gate` (sibling of the work dir, never inside it).
  - Summary column `round 2+` (share of runs with rounds >= 2) and `stuck` (runs with stuck > 0) in the per-config table and per-case table.

- [ ] **Step 1:** In `setupRepo`, when `c.gate`: copy `evals/gate/<id>/` to `gateDir(dir, c)`; read-modify-write `dir/.orchestrator/config.json` (create if missing) adding `gateChecks: {gate: c.gate.replaceAll("{gate}", <abs gate dir, forward slashes>)}`. Do this right after `servePort(dir)`, before `git add -A`. The fixtures' `.gitignore` lists `.orchestrator/`, so the config stays untracked and orch's dirty check (which excludes `.orchestrator`) is unaffected.
- [ ] **Step 2:** In `grade`, substitute `{gate}` in `c.grade` with the pristine `evals/gate/<id>` absolute path (forward slashes, quoted).
- [ ] **Step 3:** `--reference`: for cases with `gate`, additionally run the gate command (pristine path) on the untouched and reference repos; `ok` also requires gate fails untouched and passes reference. Print `gate: fails/PASSES (too weak)` and `gate: passes/FAILS`. Fail with a clear message when `evals/gate/<id>` is missing.
- [ ] **Step 4:** Summary columns as in Interfaces.
- [ ] **Step 5:** Verify free: `node evals/run.ts --reference` (existing 28 cases still `ok`), and `node evals/run.ts --cases node-lru --claude-bin test/fake-claude/claude.cmd` produces a summary with the new columns.
- [ ] **Step 6:** README: `gate` field in "Adding a case", the gate column, a "Gate cases" paragraph (suites in `evals/gate/<id>/`, copied next to the work dir, agents cannot read them, grade uses the pristine copy).
- [ ] **Step 7: Commit** `feat(evals): gate suites outside the repo; round 2+ column`

### Task 5: Three gate cases

**Files:**
- Create per case: `evals/gate/<id>/`, `evals/hidden/<id>/`, `evals/reference/<id>/`, fixture changes or new fixture; `cases.json` entries; README case table rows.

**Interfaces:**
- Consumes: `Case.gate` with `{gate}` (Task 4). Gate test files import repo code by absolute path from `process.cwd()` (`pathToFileURL(resolve("src/x.js"))`).

Cases (kind `multi-round`, difficulty text says "gate: …"). Goals state every requirement the gate checks; the gate only checks what the goal says.

1. **`lib-intervals-perf`** on `node-lib`: `mergeIntervals` and `overlaps(a, b)` over `[start, end)` pairs with validation; goal states "must handle 200,000 intervals in under a second". Gate: 200,000 random intervals (seeded), asserts result equals a sort-based oracle and the call finishes under 2 s (O(n log n) runs in ~0.1 s: 10x+ headroom; O(n²) does not finish). Failure lines: input size and which property, no ms.
2. **`lib-recurrence-fuzz`** on `node-lib`: `nextOccurrences(rule, from, count)` for daily / weekly (weekday set) / monthly (day of month, clamped or skipped per goal) rules in UTC. Gate: 2,000 seeded random rules compared with a brute-force day-by-day oracle in the gate; on failure prints the smallest failing rule and both outputs.
3. **`tickets-export-e2e`** on `node-tickets`: `GET /tickets/export?status=&assignee=` returning RFC 4180 CSV (header, CRLF, quoting of commas, quotes and line breaks, filters combined). Gate: starts the app's server on a free port, creates tickets with awkward titles through the API, transitions some, exports with each filter combination and parses with a strict parser in the gate; prints the first mismatching row.

- [ ] **Step 1:** Build case 1 (gate, hidden tests that cover the goal plus the fixture's tests plus `{gate}`, reference, `cases.json`). `node evals/run.ts --reference --cases lib-intervals-perf` → `ok` with gate fails / passes. Commit.
- [ ] **Step 2:** Same for case 2. Commit.
- [ ] **Step 3:** Same for case 3. Commit.
- [ ] **Step 4:** Run the gate of each reference 5 times in a row; all pass (no flakiness). Run the perf gate under `--parallel 3` load once; still passes.
- [ ] **Step 5:** README case table rows. Commit `feat(evals): three gate cases for fix rounds`.

### Task 6: Discrimination and measurement runs (spends money; ask first)

- [ ] **Step 1:** Ask the user before running. Then `node evals/run.ts --cases lib-intervals-perf,lib-recurrence-fuzz,tickets-export-e2e --power economy --repeat 3 --parallel 2 --max-rounds 4 --max-cost 3 --wait-on-limit`.
- [ ] **Step 2:** A case is kept if at least 2 of 3 runs reach round 2 (`round 2+` column) and hidden pass is not 0/3 for a reason outside the goal (read `.grade.log`). Report per case to the user; rework or drop the rest (back to Task 5 for that case).
- [ ] **Step 3:** Ask again, then `--power economy,economy+noresume,economy+diffcritic,economy+review --repeat 3` on the kept cases.
- [ ] **Step 4:** Write `docs/evals/<date>.md` (same shape as `2026-11-18.md`: setup, tables, what it means, including how often stuck rounds and escalation happened); update TODO.md "Measure these" and "Harder cases first"; CHANGELOG. Commit `docs(evals): fix-round results`.
