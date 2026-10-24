@AGENTS.md

## Claude Code notes

- `AGENTS.md` (imported above) is canonical; put shared guidance there, not here.
- Use `/parity-check <feature>` (`.claude/commands/parity-check.md`) before changing anything in the shared contract
  (note format, ids, links, attachments, manifest, conflicts, validation, sync layout) and to audit sibling apps.
- Use the `gh` CLI to read the sibling repositories (MaxDac/MarkNotes, MaxDac/marknotes-electron,
  MaxDac/marknotes-spec) instead of guessing their behaviour.
- On Windows the toolchain lives in WSL via Mise: run commands as `wsl -e bash -lc 'cd <repo> && mise exec -- <cmd>'`.
- Prefer the narrowest check first (`npx vitest run tests/sync.test.ts`, hosting contracts), then the full CI table.
