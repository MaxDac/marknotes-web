# Copilot instructions — MarkNotes Web

Read [`AGENTS.md`](../AGENTS.md) first; it is the canonical guide (setup, CI-mirroring commands, architecture,
deploy/release, sibling repos, parity rules). Key rules:

- Caddy serves only static HTML/assets, `/health` and OAuth callback pages. Storage, editor, preview and
  **sync** (`assets/js/sync.ts`) run in the browser. Note content, paths and tokens must never reach the server.
- Before pushing, run the commands in the AGENTS.md CI table (static hosting contracts, Caddy/shell validation,
  npm audit, asset checks, parity, Playwright and Docker). Do not rename CI jobs; they are required checks.
- Note format, ids, `marknotes:` links, `attachments/`, `.marknotes/manifest.json` (format 1), conflict handling and
  path validation are shared with the Android (MaxDac/MarkNotes) and desktop (MaxDac/marknotes-electron) apps.
  Change them in MaxDac/marknotes-spec first, mirror them in both siblings, and fill in the PR template's
  **Parity impact** section.
- To audit a feature across apps, use `.github/prompts/parity-check.prompt.md`.
- Proton Drive is out of scope (issue #1); no Proton login or proxy.
