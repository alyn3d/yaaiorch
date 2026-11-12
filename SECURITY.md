# Security

YAAIORCH runs AI agents that edit files and run commands, so the permission model matters. Please
report security problems privately, not in public issues.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/alyn3d/yaaiorch/security/advisories/new).
Include what you found, how to reproduce it, and what an attacker could do with it. You should get a
first answer within a week. Please give a reasonable time to fix it before disclosing publicly.

## In scope

- An agent escaping its permissions: a read-only role (architect, QA) editing files, an implementer
  running commands outside the allow-list, or anything reaching outside the target repo.
- The browser-mode server (`orch-ui/server.ts`) being driven by a web page or another user
  (it listens on `127.0.0.1` only, refuses requests whose `Host` or `Origin` is not local, and requires a
  per-process session token on every `/api` call; see `refuse()` in `server.ts`).
- Git handling that loses user work (rollback, park, prune) or commits files it should not.
- Command injection through goals, file names, config or agent output.

## Out of scope

- What the model writes in your repo when you ask it to: review commits before you push them.
- Issues in Claude Code itself: report those to Anthropic.

## Supported versions

Only the latest `main` is supported while the project is at 0.x.
