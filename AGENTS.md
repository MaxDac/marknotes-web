# AGENTS.md — MarkNotes Web

Canonical instructions for coding agents (Claude Code, GitHub Copilot, others) working in this repository.
`CLAUDE.md` and `.github/copilot-instructions.md` point here; keep this file the single source of truth.

MarkNotes Web is a Phoenix LiveView shell around a **browser-only** markdown notes app with two-way sync to Dropbox and
OneDrive. It is one of three MarkNotes apps that share one note format and one synced folder layout (see
[Sibling repositories](#sibling-repositories) and [Cross-app parity rules](#cross-app-parity-rules)).

## Setup

Runtimes are pinned in `.tool-versions` (Erlang, Elixir, Node.js) and shared with CI; use Mise (or asdf).
No database, Docker or cloud credentials are needed.

```sh
git submodule update --init spec   # marknotes-spec (shared format + fixtures)
mise trust && mise install
mise run setup        # hex/rebar, deps, assets build, compile
mise run dev          # http://localhost:4000 (assets are built, not watched; rebuild after editing assets)
```

On WSL, make sure the Mise/asdf shims precede Windows executables (`mise exec -- <cmd>` if unsure).

## Build and test (mirrors CI)

`.github/workflows/checks.yml` is the contract. Run the matching commands before pushing:

| CI check (`Checks / …`) | Local command |
| --- | --- |
| Elixir (compile, format, credo, test) | `mix deps.unlock --check-unused && mix compile --warnings-as-errors && mix format --check-formatted && mix credo --strict && mix test --warnings-as-errors` |
| Dependencies (audit) | `mix hex.audit && mix deps.audit && mix sobelow --config && (cd assets && npm audit --audit-level=high)` |
| Dialyzer | `mix dialyzer` |
| Parity (marknotes-spec fixtures) | `git submodule update --init spec && cd assets && npm run parity` |
| Assets (prettier, tsc, eslint, vitest) | `cd assets && npm ci && npm run check` |
| Browser E2E (Playwright) | `cd assets && npx playwright install --with-deps chromium && npm run e2e` (starts its own server on :4000) |
| Docker image build | `docker build .` |

Shortcuts: `mise run check` (everything except E2E/Docker/audit), `mise run audit`, `mise run e2e`.
`pr-ci.yml` additionally runs **Dependency review** (fails on `high`) and **actionlint**; `codeql.yml` runs CodeQL
for `javascript-typescript` and `actions`. Do not rename CI job names: they are required checks in the `main` ruleset.

Sobelow fails on any finding. Real false positives are suppressed narrowly: inline `# sobelow_skip ["Check.Id"]`
above the function, or a documented entry in `.sobelow-conf` for whole-app checks.

## Architecture

| Runs where | What | Code |
| --- | --- | --- |
| Server (Phoenix) | Serves the LiveView shell, static assets, `/health`, and minimal OAuth callback pages (`/oauth/:provider`). Holds **no** note data, tokens or paths. | `lib/marknotes_web/` (`router.ex`, `live/notes_live.ex`, `controllers/page_controller.ex`, `privacy_headers.ex` = CSP) |
| Server config | Public Dropbox/OneDrive app IDs (`DROPBOX_APP_KEY`, `MSAL_CLIENT_ID`) injected at runtime | `config/runtime.exs` |
| Browser | Everything else: storage, editor, preview, sync, provider APIs, OAuth | `assets/js/` |

Browser modules (`assets/js/`):

- `storage.ts` — IndexedDB `Store` (notes tree, per-drive sync records) and encrypted credential `Vault`; path validation.
- `sync.ts` — **sync engine**: manifest (`.marknotes/manifest.json`, `format: 1`), SHA-256 change detection,
  newest-wins reconciliation with ` (conflicted copy).md` siblings, multi-drive `syncAll`.
- `providers.ts` — Dropbox and OneDrive (`Drive`/`Remote`) implementations (cursors / Graph delta).
- `auth.ts` — Dropbox PKCE and MSAL.js; `callback.ts` — OAuth popup callback page.
- `notemeta.ts` — note ids in YAML front-matter, `marknotes:` links, `@` mention refs.
- `attachments.ts` — `attachments/<sha256>.<ext>` images: hashing, downscaling, references, cleanup.
- `editor.ts` — CodeMirror 6 editor and markdown-it preview (sanitised with DOMPurify).
- `chords.ts` — chord sequences (`type: chords` notes): detect, parse, canonical serialise, validate, display names.
- `chord-editor.ts` — graphical chord-sequence editor (chord list, fretboard builder), shown instead of `editor.ts`.
- `ui.ts`, `components.ts`, `app.ts` — UI and LiveView hook wiring.

Tests: ExUnit in `test/` (server only); vitest in `assets/tests/` (unit, sync against `fake-drive.ts`); spec fixtures in
`assets/parity/` (`npm run parity`, separate config so `npm run check` works without the submodule); Playwright in
`assets/e2e/` (network fixtures, no real accounts).

Shared format reference: `spec/note-format.md` (the `marknotes-spec` git submodule at `spec/`; `docs/note-format.md`
only points there). `assets/parity/fixtures.test.ts` runs every `spec/fixtures` file against the real browser code.

## Conventions

- Elixir: `mix format`, Credo strict, no compile warnings, Dialyzer clean. TypeScript: strict `tsc`, ESLint, Prettier.
- Privacy invariants (never break): note content, paths, tokens and editing events never reach Phoenix or server
  sessions; cloud calls go directly from the browser to the provider; the preview never loads remote images or raw HTML.
- Keep the CSP in `privacy_headers.ex` tight; adding an origin needs a reason in the PR.
- Sync changes need vitest coverage against the fake drive; UI flows touching providers need Playwright fixtures.
- Proton Drive is out of scope until [#1](https://github.com/MaxDac/marknotes-web/issues/1) is resolved; do not add a
  Proton login or proxy. If you work on it, follow the README "Proton follow-up requirements".
- Update `README.md` when behaviour, commands or CI change. Commit messages use Conventional Commits (`feat:`, `fix:`, `ci:`, `docs:`…).

## Deploy and release

- Every push to `main` runs `fly.yml`: all checks, then `deploy.yml` (Fly.io `marknotes`, `--remote-only --ha=false`,
  smoke test asserting `/health` reports the deployed `revision`).
- `release.yml` (manual, `main` only): validates `X.Y.Z`, runs checks, creates the `vX.Y.Z` GitHub Release (no binary
  assets: the product is the deployment), deploys with `APP_VERSION`, verifies `/health` `version`, writes a release
  summary (version, pre-release, tag, deployed URL).
- Never run `fly deploy` concurrently with a workflow, rotate secrets, or recreate the Fly app/provider registrations
  unless explicitly asked. The Docker build copies only `mix.*`, `config/`, `lib/`, `priv/` and `assets/`.

## Sibling repositories

| App | Repository | Stack | Sync engine lives in |
| --- | --- | --- | --- |
| Web (this repo) | [MaxDac/marknotes-web](https://github.com/MaxDac/marknotes-web) | Phoenix LiveView + TypeScript, Fly.io | `assets/js/sync.ts` |
| Android | [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes) | Kotlin / Gradle | see its `AGENTS.md` |
| Desktop | [MaxDac/marknotes-electron](https://github.com/MaxDac/marknotes-electron) | Electron / TypeScript | see its `AGENTS.md` |
| Spec | [MaxDac/marknotes-spec](https://github.com/MaxDac/marknotes-spec) | Markdown + JSON fixtures | `note-format.md`, `features.md`, `fixtures/<area>/*.json` |

Inspect a sibling without cloning: `gh api repos/MaxDac/<repo>/contents/<path> --jq .content | base64 -d`,
`gh search code --repo MaxDac/<repo> '<symbol>'`, or `gh repo clone MaxDac/<repo> /tmp/<repo> -- --depth 1`.

## Cross-app parity rules

All three apps read and write the same drive folder, so these areas are a **shared contract**:
note format and front-matter ids, `marknotes:` note links, `attachments/` naming and sync, `.marknotes/manifest.json`
(format 1), conflict handling (newest wins + conflicted copies), path/name validation, and provider folder layout.

1. A change to any of these lands in **marknotes-spec first** (`note-format.md`, `features.md` parity matrix and the
   JSON golden fixtures `fixtures/<area>/*.json`).
2. Then implement it here **and** open/track the mirrored change in the Android and desktop repos. Do not merge a
   format-breaking change that other apps cannot read.
3. If this app intentionally differs, record it in the fixture as `knownDivergence.web` with a reason, and in
   `features.md`. The parity runner asserts such cases still differ (so a fix is noticed); never edit fixtures or
   loosen `expected` here. Failing cases not yet recorded in the spec go in the runner's `pending` map with a TODO.
   Bump the pin with `git -C spec fetch && git -C spec checkout <sha>` (Dependabot also opens `gitsubmodule` PRs).
4. Every PR fills in the **Parity impact** section of the PR template.
5. To audit a feature across apps, use the parity-check prompt: `/parity-check <feature>` in Claude Code
   (`.claude/commands/parity-check.md`) or `.github/prompts/parity-check.prompt.md` in Copilot.
