# Copilot instructions — MarkNotes Web

Read [`AGENTS.md`](../AGENTS.md) first; it is the canonical guide (setup, CI-mirroring commands, architecture,
deploy/release, sibling repos, parity rules). Key rules:

- Phoenix serves only the LiveView shell, assets, `/health` and OAuth callback pages. Storage, editor, preview and
  **sync** (`assets/js/sync.ts`) run in the browser. Note content, paths and tokens must never reach the server.
- Before pushing, run the commands in the AGENTS.md CI table (`mix` format/credo/test/dialyzer, audits/sobelow,
  `cd assets && npm run check`, Playwright for UI). Do not rename CI jobs; they are required checks.
- Note format, ids, `marknotes:` links, `attachments/`, `.marknotes/manifest.json` (format 1), conflict handling and
  path validation are shared with the Android (MaxDac/MarkNotes) and desktop (MaxDac/marknotes-electron) apps.
  Change them in MaxDac/marknotes-spec first, mirror them in both siblings, and fill in the PR template's
  **Parity impact** section.
- To audit a feature across apps, use `.github/prompts/parity-check.prompt.md`.
- Proton Drive is out of scope (issue #1); no Proton login or proxy.
