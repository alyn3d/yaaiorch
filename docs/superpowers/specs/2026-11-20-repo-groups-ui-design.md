# Repo groups in the UI: design

Second phase of [2026-11-19-repo-groups-design.md](2026-11-19-repo-groups-design.md). The CLI (`orch group ...`) and the
events are done; this adds the group page to both UIs (browser server and desktop app).

## Intent

Define, start, approve, stop and roll back a repo group from the UI, and see its contract, its per-repo goals and its
step, while each member repo keeps showing its own run (tasks, log, diff) in its own tab, as it does today.

## Approaches

- **A. A sidebar entry per group, with its own session (picked).** A group gets a session like a repo: process, log,
  events, start queue, Stop. The backends already speak of "the group's session" when they route `group_child`.
- B. One "Groups" page that lists and runs groups inline. Fewer sidebar entries, but a second kind of run state outside
  the session model, so start queue, budget and replay would be written twice.

## Design

### Group sessions (both backends)
- A group session is keyed by its run dir (`~/.yaaiorch/groups/<name>/`, `YAAIORCH_HOME` respected), a real folder, so
  spawning, keys and `.orchestrator` reads work unchanged. `orch group list --json` now carries `dir` per group.
- The backends list groups at start and after every save or remove, and keep one session per group (with its config in
  the session state as `group`). Group sessions are not saved in the remembered repo list.
- Starts (`run` on a group session) become `orch group run NAME <goal>` with power, rounds, max cost, models,
  approve-plan and fast. The daily budget caps `--max-cost`; the start queue, holds and parallel count work as for repos
  (a group counts as one run).
- Busy rules: while a group session runs or waits to start, its members' sessions report `inGroup: <name>` and refuse
  their own starts; a group start is refused while a member session runs or waits. Members are opened as repo tabs when
  the group starts, so their events are routed there. The backends re-send the members' state when the group starts,
  queues or ends.
- Stop on a running group calls `orch group stop NAME` (the group parks both repos); only when that fails is the
  process tree killed. A waiting start is cancelled as before.
- Approve on a group session calls `orch approve --group NAME` (`--reject`, or `--plan-stdin` with `{contract, goals}`).
  Roll back on a group session starts `orch group rollback NAME`.
- New calls: save a group (`orch group add`, which now keeps an existing group's `contract` and `integrationRounds`),
  remove a group (`orch group remove`, refused while it runs). Browser: `/api/group-save`, `/api/group-remove` (behind
  the guard). Desktop: `save_group`, `remove_group`.

### Events
- New: `group_approval_wait {round, contract, goals}` when a group plan waits for approval, and
  `group_approval {round, action}` once answered. `reduce.ts` keeps it as `run.group.approval`.

### UI
- Sidebar: a **Groups** section under Repos, each group with a status dot, and **+ New group**.
- Group page: header (name, members with role and path; Edit, Remove), goal box (power, rounds, max $, approve plan,
  fast path), run card (status, step and round, per-repo goals, fault call, end and parked branches, contract in a
  disclosure), approval panel (Build it, Edit as JSON, Send back), Roll back with a confirm, live output with Stop.
- Group form: name, backend and frontend folder (picked from open repos or typed), the backend's serve URL, serve
  command and base URL, the frontend's env (`NAME=VALUE` lines, `{backend}` for the backend's URL).
- Member repo tabs: "running in group NAME" as their status, a notice on the page, Run and the queue buttons disabled.
  After a reload, a member whose group still runs is not shown as stopped.
- Notifications: group passed or failed, group plan waiting.

## Non-goals
- More than two repos, PR mode, `--on-limit wait` for groups (still open in TODO.md).
- Usage caps for group children (`--usage-cap` is not passed through by `orch group run`); the global hold still stops
  new group starts.

## Calls made here (correctable)
- A group takes one parallel slot, though it runs two builds at once.
- Opening a group's member repos as tabs on start, rather than asking.
