# AGENTS.md — MarkNotes Web

Canonical instructions for coding agents (Claude Code, GitHub Copilot, others) working in this repository.
`CLAUDE.md` and `.github/copilot-instructions.md` point here; keep this file the single source of truth.

MarkNotes Web is a static, offline-capable **browser-only** TypeScript PWA with two-way sync to Dropbox and
OneDrive. It is one of three MarkNotes apps that share one note format and one synced folder layout (see
[Sibling repositories](#sibling-repositories) and [Cross-app parity rules](#cross-app-parity-rules)).

## Setup

Node is pinned in `.tool-versions` and shared with CI; use Mise (or asdf). Production uses Caddy, not Node.
No database, Docker or cloud credentials are needed.

```sh
git submodule update --init spec   # marknotes-spec (shared format + fixtures)
mise trust && mise install
mise run setup        # npm ci + static build
mise run dev          # Vite with asset watching on http://localhost:4000
```

On WSL, make sure the Mise/asdf shims precede Windows executables (`mise exec -- <cmd>` if unsure).

## Build and test (mirrors CI)

`.github/workflows/checks.yml` is the contract. Run the matching commands before pushing:

| CI check (`Checks / …`) | Local command |
| --- | --- |
| Elixir (compile, format, credo, test) (legacy required label) | `cd assets && npm run build && npm run contracts` (Caddy on PATH) |
| Dependencies (audit) | `cd assets && npm audit --audit-level=high` |
| Dialyzer (legacy required label) | `caddy validate --config Caddyfile --adapter caddyfile && shellcheck deploy/*.sh` |
| Parity (marknotes-spec fixtures) | `git submodule update --init spec && cd assets && npm run parity` |
| Assets (prettier, tsc, eslint, vitest) | `cd assets && npm ci && npm run check` |
| Browser E2E (Playwright) | `cd assets && npx playwright install --with-deps chromium && npm run e2e` (starts its own server on :4000) |
| Docker image build | `docker build -t marknotes:test . && sh deploy/test-container.sh marknotes:test` |

Shortcuts: `mise run check` (everything except E2E/Docker/audit), `mise run audit`, `mise run e2e`.
`pr-ci.yml` additionally runs **Dependency review** (fails on `high`) and **actionlint**; `codeql.yml` runs CodeQL
for `javascript-typescript` and `actions`. Do not rename CI job names: they are required checks in the `main` ruleset.

Install Caddy for Linux x86-64 tests with `sh deploy/install-caddy.sh /tmp/marknotes-caddy` and add that directory to
PATH. This verifies the upstream SHA-512 checksum. Production browser tests use Caddy and a built `assets/dist`,
not Vite's dev/preview server. Existing Elixir/Dialyzer job names are retained because the live ruleset requires them;
they now perform substantive static hosting/config checks. Renaming them requires separately authorized ruleset work.
Hosting contracts compare metadata with `GIT_SHA` / `APP_VERSION` (or the documented local defaults). If building
with overrides, pass them to the contracts too. CI uses explicit metadata; container contracts accept optional
expected revision/version arguments: `sh deploy/test-container.sh <image> <revision> <version>`.

## Architecture

| Runs where | What | Code |
| --- | --- | --- |
| Static server (Caddy) | Serves HTML/assets, `/health`, `/security`, and exact OAuth callback routes. No sessions, cookies, sockets, note data, or tokens. | `Caddyfile`, `assets/*.html`, `assets/oauth/` |
| Public runtime config | Public Dropbox/OneDrive app IDs (`DROPBOX_APP_KEY`, `MSAL_CLIENT_ID`), serialized once at container startup | `deploy/start.sh`, `assets/public-config.mjs`, `assets/js/config.ts` |
| Build | Vite creates `assets/dist`; Node is absent from the production image | `assets/vite.config.ts`, `assets/build.mjs`, `Dockerfile` |
| Browser | Everything else: storage, editor, preview, sync, provider APIs, OAuth | `assets/js/` |

Browser modules (`assets/js/`):

- `storage.ts` — `Store` (notes tree, per-drive sync records and base copies) and encrypted credential `Vault`;
  path validation.
- `backend.ts` — storage backends behind `Store`: IndexedDB (schema, `sealed`/`meta` stores) and an in-memory
  backend for locked/memory-only modes.
- `security.ts` — storage modes (plain / passphrase-locked / memory only), PBKDF2 + AES-GCM sealing of the
  working set, mode switching, single-tab Web Lock, forget device. Threat model: `docs/security.md`, kept in sync
  with the script-free `/security` page (`assets/security.html`).
- `sync.ts` — **sync executor**: the algorithm (plan, three-way merge, newest-wins reconciliation with
  ` (conflicted copy).md` siblings, manifest `.marknotes/manifest.json` `format: 1`, multi-drive scheduling) comes from
  the shared core [marknotes-sync](https://github.com/MaxDac/marknotes-sync) (`@marknotes/sync`, Rust → WebAssembly,
  installed from its GitHub release tarball). `sync.ts` only lists/hashes the local tree, runs the planned actions
  against the drive and IndexedDB, and reports conflicts; `syncAll` drives the core's `SyncScheduler`.
  Change sync semantics in marknotes-sync (and the spec), not here.
- `conflicts.ts` — conflict merge-back (three-way merge of the conflicted copy into the note, per-hunk
  Kept/Copy/Both/Neither, edit, discard, keep both) and its dialog view.
- `providers.ts` — Dropbox and OneDrive (`Drive`/`Remote`) implementations (cursors / Graph delta).
- `auth.ts` — Dropbox PKCE and MSAL.js; `callback.ts` — OAuth popup callback page.
- `notemeta.ts` — note ids in YAML front-matter, `marknotes:` links, `@` mention refs.
- `attachments.ts` — `attachments/<sha256>.<ext>` images: hashing, downscaling, references, cleanup.
- `editor.ts` — CodeMirror 6 editor and markdown-it preview (sanitised with DOMPurify).
- `chords.ts` — chord sequences (`type: chords` notes): detect, parse, canonical serialise, validate, display names.
- `chord-editor.ts` — graphical chord-sequence editor (chord list, fretboard builder), shown instead of `editor.ts`.
- `ui.ts`, `components.ts`, `app.ts` — UI and direct browser startup.
- `config.ts`, `pwa.ts`, `sw.ts` — validated public configuration, offline readiness/update UX, generated Workbox
  precache. Cache only public assets/config; never provider calls, OAuth responses, note content, or tokens.

Tests: Node hosting contracts in `assets/server-tests/`; vitest in `assets/tests/` (unit, sync against `fake-drive.ts`); spec fixtures in
`assets/parity/` (`npm run parity`, separate config so `npm run check` works without the submodule); Playwright in
`assets/e2e/` (network fixtures, no real accounts).

Shared format reference: `spec/note-format.md` (the `marknotes-spec` git submodule at `spec/`; `docs/note-format.md`
only points there). `assets/parity/fixtures.test.ts` runs every `spec/fixtures` file against the real browser code.

## Conventions

- TypeScript: strict `tsc`, ESLint, Prettier. Caddy: `caddy fmt`, `caddy validate`; shell: POSIX sh and shellcheck.
- Privacy invariants (never break): note content, paths, tokens and editing events never reach the app server or server
  sessions; cloud calls go directly from the browser to the provider; the preview never loads remote images or raw HTML.
- Keep the CSP in `Caddyfile` tight; adding an origin needs a reason in the PR (and, for OneDrive download
  hosts, the matching list in `providers.ts`). Update `docs/security.md` and `/security` when protections change.
- Sync changes need vitest coverage against the fake drive; UI flows touching providers need Playwright fixtures.
- Proton Drive is out of scope until [#1](https://github.com/MaxDac/marknotes-web/issues/1) is resolved; do not add a
  Proton login or proxy. If you work on it, follow the README "Proton follow-up requirements".
- Preserve IndexedDB schema/identity and HTTPS origin during infrastructure migrations. Installed workers must not
  force reloads, lose memory-only notes, cache private data, or repopulate caches after Forget this device.
- Updates require a successful save, no unfinished chord and no other editing tabs. Sync remains foreground-only.
- Update `README.md` when behaviour, commands or CI change. Commit messages use Conventional Commits (`feat:`, `fix:`, `ci:`, `docs:`…).

## Deploy and release

- Every push to `main` runs `fly.yml`: all checks, then `deploy.yml` (Fly.io `marknotes`, `--remote-only --ha=false`,
  smoke tests asserting health status, exact revision/version, public routes/404s and the actual minimum-resource inventory).
- `release.yml` (manual, `main` only): validates `X.Y.Z`, runs checks, creates the `vX.Y.Z` GitHub Release (no binary
  assets: the product is the deployment), deploys with `APP_VERSION`, verifies `/health` `version`, writes a release
  summary (version, pre-release, tag, deployed URL).
- Never run `fly deploy` concurrently with a workflow, rotate secrets, or recreate the Fly app/provider registrations
  unless explicitly asked. The multi-stage Docker build uses Node, then ships only Caddy, public assets/config and jq.
  No deployment is implied by local implementation or testing; deployment handoffs must identify revision, tests,
  origin preservation, provider settings and worker-aware rollback.
- Issue #34 still requires direct app deletion/replacement despite the existing app already running the PWA in place.
  Plan approval authorizes no production mutation; spending approval, independently tested recovery and immediate
  exact-resource destruction confirmation are separate gates. With authorization, pause Fly Deploy/Release and drain
  deployments before cutover merges. Preserve/test the current known-good PWA image outside the app registry and
  securely establish configuration restoration; historical Phoenix artifacts are not the default recovery baseline.
  App deletion deletes images/secrets too, and same-name reclamation is not guaranteed. Agree any fallback hostname/OAuth
  changes, preserve browser data and save-safe worker updates, verify acceptance/resources and only then restore prior
  automation. Readiness reviews must not probe app routes that could wake Machines. See README's migration runbook.

## Sibling repositories

| App | Repository | Stack | Sync engine lives in |
| --- | --- | --- | --- |
| Web (this repo) | [MaxDac/marknotes-web](https://github.com/MaxDac/marknotes-web) | TypeScript PWA + Vite/Caddy, Fly.io | [MaxDac/marknotes-sync](https://github.com/MaxDac/marknotes-sync) (`@marknotes/sync`); executor in `assets/js/sync.ts` |
| Android | [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes) | Kotlin / Gradle | see its `AGENTS.md` |
| Desktop | [MaxDac/marknotes-electron](https://github.com/MaxDac/marknotes-electron) | Electron / TypeScript | see its `AGENTS.md` |
| Spec | [MaxDac/marknotes-spec](https://github.com/MaxDac/marknotes-spec) | Markdown + JSON fixtures | `note-format.md`, `features.md`, `fixtures/<area>/*.json` |

Inspect a sibling without cloning: `gh api repos/MaxDac/<repo>/contents/<path> --jq .content | base64 -d`,
`gh search code --repo MaxDac/<repo> '<symbol>'`, or `gh repo clone MaxDac/<repo> /tmp/<repo> -- --depth 1`.

## Cross-app parity rules

All three apps read and write the same drive folder, so these areas are a **shared contract**:
note format and front-matter ids, `marknotes:` note links, `attachments/` naming and sync, `.marknotes/manifest.json`
(format 1), conflict handling (three-way merge, then newest wins + conflicted copies), path/name validation, and
provider folder layout. The sync algorithm itself is shared code: [marknotes-sync](https://github.com/MaxDac/marknotes-sync).

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
