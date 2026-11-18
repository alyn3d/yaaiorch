# Instructions for GitHub Copilot

YAAIORCH is an AI coding orchestrator: `orch.ts` (a Node CLI) drives Claude Code agents through
plan → build → checks → QA rounds; `orch-ui/` is a React UI served by `orch-ui/server.ts` (browser) or a
Tauri v2 desktop app (`orch-ui/src-tauri/src/main.rs`).

**Read [CLAUDE.md](../CLAUDE.md) before changing code.** It is the project's map: layout, the event protocol,
and the rules below in more detail. [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) has the design.

## Rules that are easy to break

- **Three places stay in sync.** A new UI action or event needs `orch-ui/server.ts` (browser), `main.rs`
  (desktop) and `orch-ui/src/transport.ts` (and `reduce.ts` for events). Never change only one backend.
- **New `/api` routes go after the guard** (`refuse()` in `server.ts`); never before it.
- **State files:** write through `writeFileAtomic`; edit the queue only through `updateQueue`. Never write
  `.orchestrator/queue.json` directly, from orch or a backend (backends call `orch add`, `orch retry`, ...).
- **Spawning Claude Code:** only through `spawnClaude` / `claudeSync` (or `resolveClaude` in `claude-bin.ts`),
  never with `shell: true`. Children use `windowsHide: true`. Windows is the primary platform.
- **Read-only roles stay read-only:** the architect, QA, critic and reviewers run with
  `--permission-mode default` and `readonly-settings.json`. Do not give them edit tools or Agent M.
- **Never log a secret's value**; use `redactOutput` for anything agent-provided that is shown or stored.
- **Open source:** never commit personal data, local paths, secrets or eval results.

## Every change

- Add a **scenario test** for new loop behaviour (`test/scenarios.test.mjs`, using the fake Claude in
  `test/fake-claude/`; its switches are documented at the top of `fake-claude.mjs`). Pure helpers get unit
  tests (`test/unit.test.mjs`; export them at the bottom of `orch.ts`). No test may call the real `claude`.
- Add a line to `CHANGELOG.md` under `[Unreleased]`, and update `README.md` / `CLAUDE.md` /
  `docs/ARCHITECTURE.md` when behaviour or a flag changes.
- Run the checks in `orch-ui/` and fix what fails before you finish:

  ```bash
  npm run build          # typecheck + Vite build
  npm run lint
  npm run format:check   # Prettier, printWidth 160; npm run format fixes it
  npm test               # about 10 minutes; all scenarios, unit and server tests
  ```

  If you touched Rust: `cd orch-ui/src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`.

## Style

- TypeScript, small functions, comments that say *why*. Match the surrounding code; do not reformat
  unrelated lines.
- UI text and docs: plain, short sentences; name things the way the UI does (**bold** for buttons).
- Keep changes focused on the task. Mention follow-ups in the PR description instead of doing them.
