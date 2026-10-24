# MarkNotes Web

Web markdown notes app built with Phoenix LiveView, with folders and sync to Dropbox and
OneDrive. It is the web sibling of the Android app [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes) and the desktop app
[MaxDac/marknotes-electron](https://github.com/MaxDac/marknotes-electron). It uses the Android format-1 sync layout.

Production target: <https://marknotes.fly.dev>. Deployment and real-account sign-in verification are separate from
the automated provider tests.

> **This is a third-party application not officially supported by Proton.**
> MarkNotes is a personal, non-commercial project. It is not affiliated with or endorsed by Proton AG,
> and it does not use any Proton logos or branding.

> **Status:** initial application implementation. Dropbox and OneDrive are included.
> **Proton Drive is deferred** to [#1](https://github.com/MaxDac/marknotes-web/issues/1); there is no Proton login or proxy
> in this release. Its official SDK does not supply authentication/session/key unlocking, and a complete integration
> within the fixed-host relay constraints has not been established.

## Features

- **Notes stay in your browser**: stored in IndexedDB as a tree of folders and `.md` notes. You can create, open, rename,
  delete and move notes and folders, and a sidebar shows the folder tree. Note content is never sent to the MarkNotes server.
  The UI needs a live server connection (LiveView), but your data persists locally.
- **Editor**: raw markdown (CodeMirror 6) with a client-side preview (tables, strikethrough, task lists, highlighted code
  blocks). It has a formatting toolbar, continues lists, checkboxes and quotes on Enter, and autosaves.
- **Note links**: type `@` to pick a note from a panel listing every note's title, path and stable id (with a copy
  button); it inserts a `[Title](marknotes:id)` link that opens the note from the preview, even after renames or moves.
- **Images**: insert PNG, JPEG, GIF or WebP images with the toolbar, paste or drag-and-drop. They are downscaled to at
  most 2048 px, stored in the root `attachments/` folder, synced to every drive, and can be cleaned up from **Settings**.
  See [marknotes-spec](https://github.com/MaxDac/marknotes-spec) (`spec/` submodule) for the shared note, link and attachment format.
- **Chord sequences**: **New** → **New chord sequence** creates a note with `type: chords` in its front-matter. It opens in
  a graphical editor (ported from [ChordBuilder](https://github.com/MaxDac/ChordBuilder)) instead of the markdown editor.
  The editor shows an ordered list of guitar or bass chords with mini diagrams. You can add, edit, duplicate, delete and
  reorder chords, and each chord is built on a fretboard with fingers, tags and a note. **View as text** shows the raw
  markdown. A file that cannot be read, such as one with conflict markers, opens as text, and the parse error and its
  line number are shown. Chord files are ordinary notes, so they sync, link and conflict like any other note. The format
  is defined in the spec ("Chord sequences").
- **Appearance**: a drive-style layout (sidebar folder tree, breadcrumb, toolbar, modal dialogs and menus built as custom
  accessible components, no native prompts or selects). **Settings** offers theme System, Light or Dark, and an accent
  colour from 9 palettes.
- **Multi-drive two-way sync** with any number of Dropbox and OneDrive accounts. Sync runs in the browser,
  on load and on **Sync now**. The sync algorithm (planning, three-way merge, newest-wins conflicts, manifest,
  multi-drive scheduling) comes from the shared core [marknotes-sync](https://github.com/MaxDac/marknotes-sync)
  (`@marknotes/sync`, Rust compiled to WebAssembly), the same core the Android and desktop apps use; the web app only
  does the I/O. A note changed on both sides is three-way merged; if the edits overlap, the newest version wins and the
  other is kept as a `(conflicted copy)` note.
- **Conflicts**: after a sync with conflicts, the **Conflicts** button lists each conflicted copy next to the kept
  version. Pick per change **Kept**, **Copy**, **Both** or **Neither** and **Merge copy back** (or **Edit merged** by
  hand) to save the result as the note and delete the copy; **Discard copy** deletes the copy; **Keep both files**
  dismisses the conflict.
- **Dropbox / OneDrive login**: OAuth 2 PKCE (Dropbox) and MSAL.js (OneDrive), called directly from the browser in popups.
- Persisted app-held tokens are stored in IndexedDB, encrypted with a non-extractable AES-GCM WebCrypto key. MSAL's own
  cache stays in memory, not plaintext local/session storage. After reload, the saved access token remains usable until
  expiry; Microsoft SSO is attempted for renewal, and **Reconnect** is required if third-party-cookie/session restrictions
  prevent silent sign-in. No unsupported MSAL cache serialization is used.

Out of scope: search, tags, background sync, offline UI, local note encryption.

### Notes and cloud folders

Use **New** → **New note** / **New chord sequence** / **New folder** in the selected folder. **Rename / move** accepts a path relative to the local root.
Notes must end in `.md`; hidden names, traversal and moves into a folder's own descendants are rejected.
The editor saves automatically and flushes before navigation or sync. Wait for **Saved in this browser** before closing
the tab; a failed/stale save leaves the text in the editor and displays an error.

Connect a drive and browse to the same folder used by Android/desktop. By default the picker creates/uses a `MarkNotes`
child folder; uncheck that option to sync the selected folder itself. A new connection is reconciled with **Sync now**.
All accounts mirror the same local tree; they are not independent notebooks. Disconnect removes only that connection's
local credentials/history, not local notes or provider-side app authorization.

Sync follows initial listings with Dropbox cursors / Microsoft Graph delta feeds, not background polling. Per-drive
sync records persist locally. The remote `.marknotes/manifest.json` has `format: 1`, `app: "MarkNotes"`,
device ID, epoch-millisecond timestamps and path-keyed `sha256`/`version`/`syncedAt` entries. Identical content is recognized
by SHA-256. A note changed in more than one place (this browser, Dropbox, OneDrive, or Proton Drive through the
Android/desktop apps writing to the same folder) is first three-way merged against the last synced version (kept per
drive in this browser). If the edits overlap, **newest wins**: the version with the latest edit time is kept
everywhere, and the other is saved as a ` (conflicted copy).md` sibling (` (conflicted copy) 2.md`, … if taken) with a
new note id, and uploaded, so no edit is lost. The copy is saved in this browser before the note is overwritten, then
uploaded. Local edit times are recorded per note; drive times come from Dropbox
`client_modified` and OneDrive `fileSystemInfo.lastModifiedDateTime` (falling back to the server time), which the web
app sets on upload. Equal times prefer the drive's version. Results depend on device clocks being roughly correct. Edits
survive opposing deletions: a note saved after the sync was planned is never overwritten or deleted locally (the step
waits for the next sync), and drive deletions are conditional on the revision the sync saw (Dropbox `parent_rev`,
OneDrive `If-Match`), so a file changed elsewhere meanwhile is kept and downloaded next time. Notes are downloaded and
hashed as bytes, so a UTF-8 byte order mark is kept and an unedited note is never rewritten on the drive.
Three reconciliation passes per drive bound a multi-drive run; a failing step is reported and the rest of the sync goes on.
Images in `attachments/` sync as immutable binary files named by their SHA-256 (`attachments/<sha256>.<png|jpg|gif|webp>`;
other files there are not synced): they are uploaded, downloaded or deleted, never merged. The core is WebAssembly, so
the CSP allows `'wasm-unsafe-eval'` (WebAssembly compilation only, not JavaScript `eval`).

### Privacy and durability

Notes, paths, provider tokens and editing events are not sent to Phoenix or stored in server sessions.
Cloud API calls go directly to the provider. OneDrive preauthenticated download URLs receive no Graph bearer header.
Markdown preview blocks remote images, raw HTML and unsafe links; it only shows images from the local `attachments/`
folder, as `blob:` URLs. Code blocks are highlighted locally.
OAuth callbacks are minimal client pages, not LiveViews, and authorization parameters are filtered from Phoenix logs.
By default notes are kept unencrypted in IndexedDB. Provider credentials are encrypted with a key that cannot be exported,
but that key is stored beside them. Settings › Privacy and security offers two other modes:
- **Encrypted with a passphrase:** PBKDF2 → AES-256-GCM; names are hidden on disk. The app auto-locks after 15 minutes.
- **Memory only:** nothing is written to the browser.

It also offers **Forget this device**. The browser may only connect to this origin and the Dropbox and Microsoft
endpoints it syncs with (CSP `connect-src`). No mode defends against same-origin XSS while unlocked.
See [docs/security.md](docs/security.md) (threat model, why notes are not cached on the server, residual risks) and
the in-app `/security` page. Clearing site data or browser profiles removes notes and credentials; there is no
server-side recovery. Private browsing may limit storage. WebCrypto, IndexedDB and Web Locks support are required
(secure HTTPS, or localhost). Concurrent stale edits fail visibly instead of silently overwriting a newer note.

## Development

Coding agents (and humans) should start with [AGENTS.md](AGENTS.md): CI-mirroring commands, architecture and the
cross-app parity rules shared with the Android and desktop apps.

Requirements: [Mise](https://mise.jdx.dev/) (or asdf) and the Erlang, Elixir and Node.js versions in
`.tool-versions`. Mise reads that file; `mise.toml` adds project tasks without duplicating the version pins.
No database, Docker or cloud credentials are needed to run the local editor.

On Linux, Mise may build Erlang from source. Install a C/C++ compiler, Make, Autoconf, Perl, OpenSSL development
headers and ncurses development headers first. For example:

```sh
# Debian / Ubuntu
sudo apt-get update
sudo apt-get install build-essential autoconf m4 libncurses-dev libssl-dev perl

# Arch Linux
sudo pacman -S --needed base-devel ncurses openssl perl
```

From the repository root:

```sh
git submodule update --init spec   # shared format spec and fixtures (or clone with --recurse-submodules)
mise trust
mise install                   # install the pinned runtimes (first Erlang build can take several minutes)
mise run setup                 # bootstrap Hex/Rebar, install locked dependencies, build assets and compile
mise run dev                   # rebuild and serve http://localhost:4000; Ctrl+C to stop
```

`mise run build` rebuilds without starting the server. `mise run check` runs formatting, Credo, ExUnit,
Dialyzer and the asset checks; `mise run audit` runs the dependency audits and Sobelow. `mise run e2e` builds and runs Playwright; install Chromium first as described below
and stop the development server because Playwright starts its own server on port 4000.
The development server binds only to `127.0.0.1`. `curl --fail http://localhost:4000/health` checks readiness.
Assets are built before launch, not watched; after editing client assets, rebuild and refresh the browser.

The underlying commands remain available with the pinned runtimes active (`mise exec -- <command>` if Mise
is not activated in your shell):

```sh
mix setup                      # deps + assets
mix phx.server                 # http://localhost:4000
DROPBOX_APP_KEY=... MSAL_CLIENT_ID=... mix phx.server
mix format --check-formatted && mix credo --strict && mix test
mix dialyzer
(cd assets && npm run check)   # prettier, tsc, eslint, vitest
(cd assets && npm run e2e)     # Playwright (starts the server itself)
```

`config/runtime.exs` supplies the public Dropbox and OneDrive application IDs by default; neither is baked into the
asset bundle. Users can choose **Connect Dropbox** or **Connect OneDrive**, sign in in the provider popup and select a
cloud folder. The app registrations must allow the redirect URIs and permissions listed under
[Provider registrations](#provider-registrations); configured IDs alone do not prove real-account sign-in works.

Set `DROPBOX_APP_KEY` or `MSAL_CLIENT_ID` to override the corresponding default at runtime. An unset variable uses the
default; an explicitly empty or whitespace-only value disables the provider with **not configured**. For example,
`DROPBOX_APP_KEY= MSAL_CLIENT_ID= mix phx.server` disables both. Restart the server after changing these settings.
These are public application identifiers, not client secrets or account access tokens.
`SECRET_KEY_BASE` is mandatory in production.
After changing client assets, run `mix assets.build` (or `cd assets && npm run build`); no asset watcher is required.
Make sure the version-manager shims precede Windows executables on WSL (`asdf exec mix`, `asdf exec npm` if needed).

Install the E2E browser once: `cd assets && npx playwright install --with-deps chromium`.
Playwright supplies a fake public Dropbox ID, uses network fixtures (not real accounts), and starts its own server.
The OneDrive browser fixture seeds encrypted credentials and exercises Graph downloads, conditional updates and newest-wins copies;
MSAL configuration/login is covered with an SDK mock. These tests do not prove real provider registration/consent.
If the host cannot install browser libraries, an isolated matching Playwright browser server can be used with
`PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:3030/ npm run e2e`; the Phoenix server still starts locally.

To reproduce production-mode E2E, set `MIX_ENV=prod`, `PHX_HOST=localhost`, `PORT=4000` and a throwaway `SECRET_KEY_BASE`,
then run `mix deps.get --only prod && mix compile && mix assets.deploy` before `cd assets && npm run e2e`.

### Icon

The shared MarkNotes icon (also used by the Android and desktop apps) comes from the master SVGs in `branding/`:
`marknotes-icon.svg` (app icon) and `marknotes-mark.svg` (in-app logo). The favicons, touch/manifest icons and
`site.webmanifest` in `priv/static` are generated from them and committed, so builds need no extra tooling. After
changing a master SVG, regenerate them with `cd branding && npm install --no-package-lock && npm run generate`.

## CI/CD

- `checks.yml` (reusable) has seven checks: "Elixir (compile, format, credo, test)", "Dependencies (audit)" (`mix hex.audit`
  for retired packages, `mix deps.audit` via mix_audit, the Sobelow security scan configured by `.sobelow-conf`, and
  `npm audit --audit-level=high`), "Dialyzer", "Assets (prettier, tsc, eslint, vitest)", "Browser E2E (Playwright)",
  "Docker image build" and "Parity (marknotes-spec fixtures)" (`npm run parity`: every golden fixture of the
  [marknotes-spec](https://github.com/MaxDac/marknotes-spec) `spec/` submodule run against the browser code; known
  divergences are asserted to still differ).
- `pr-ci.yml` runs them on pull requests, plus "Dependency review" (fails on high-severity vulnerable dependencies) and
  "actionlint" (workflow lint, including shellcheck of `run:` scripts).
- `codeql.yml` runs CodeQL for `javascript-typescript` and `actions` on pull requests, pushes to `main` and weekly
  (Elixir is not supported by CodeQL).
- `dependabot-automerge.yml` enables squash auto-merge for Dependabot semver patch/minor updates; majors stay manual.
  Requires "Allow auto-merge" in the repository settings; merges still wait for the required checks.
- `fly.yml` runs the checks on every push to `main` and deploys to Fly.io if they pass.
- `release.yml` is started manually on `main` (other refs are rejected) with a `version` (`X.Y.Z`) and a `prerelease`
  flag. It runs the checks, publishes the `vX.Y.Z` GitHub Release (no binary assets; the deployment is the product),
  deploys that commit to Fly and writes a release summary (version, pre-release, tag, commit, deployed URL and version).
- `deploy.yml` (reusable) is the single deploy job used by both. It fails early with a clear error if `FLY_API_TOKEN` is
  missing, runs `flyctl deploy --remote-only --ha=false`, then smoke-tests `/health` and `/` with retries, asserting that
  `/health` reports the deployed commit (`revision`) and, for releases, the release `version`. A job summary records the
  URL, image label, version and commit.

`/health` returns `{"status": "ok", "version": ..., "revision": ...}`. The version comes from `mix.exs`, which reads the
`APP_VERSION` Docker build argument (set by `release.yml`) and otherwise defaults to `0.1.0`; the revision is the
`GIT_SHA` build argument (`unknown` outside a deployed image).

## Deployment and release

### One-time setup

```bash
set -euo pipefail
set +x
fly apps create marknotes --org personal                # once; before merging changes that auto-deploy
fly ips allocate-v4 --shared -a marknotes                # only if no shared IPv4 exists
fly ips allocate-v6 -a marknotes                         # only if no IPv6 exists
SECRET_KEY_BASE=$(openssl rand -hex 64)
printf 'SECRET_KEY_BASE=%s\n' "$SECRET_KEY_BASE" | fly secrets import --stage -a marknotes
unset SECRET_KEY_BASE
fly tokens create deploy -a marknotes |
  gh secret set FLY_API_TOKEN --repo MaxDac/marknotes-web
```

Reuse the existing GitHub `production` environment; `deploy.yml` records the production URL there. No GitHub variables
are required. Keep `FLY_API_TOKEN` as a repository secret so both reusable-workflow callers can forward it.
The token is scoped to `marknotes`, not the organization; Fly's default expiry is 20 years. Rotate it by creating a
replacement, storing it in the same GitHub secret, verifying deployment, then revoking the old token with the Fly CLI.
Do not print tokens, commit them, or store them in local configuration files.

The public `DROPBOX_APP_KEY` and `MSAL_CLIENT_ID` have application defaults; no provider client secrets are needed.
Existing Fly environment values/secrets override those defaults. To use different registrations, supply runtime
overrides through `fly secrets import --stage -a marknotes` (stdin `NAME=VALUE` pairs); these IDs are public even when
stored as Fly secrets. Explicit empty/whitespace values disable the corresponding provider.
Generate `SECRET_KEY_BASE` only for initial setup; preserve it on subsequent deployments.

Register the production redirect URIs `https://marknotes.fly.dev/oauth/dropbox` (Dropbox app) and
`https://marknotes.fly.dev/oauth/onedrive` (Entra app, SPA platform); see [Provider registrations](#provider-registrations).
These changes require access to the provider registrations; `fly` and `gh` do not configure Dropbox or Entra.

### Cutting a release

1. Make sure `main` is green and deployed.
2. Actions → **Release** → *Run workflow* on `main`, with `version` = `X.Y.Z` (must not already be tagged) and
   `prerelease` as appropriate.
3. The workflow runs the checks, creates the `vX.Y.Z` tag and GitHub Release with generated notes, deploys with image label
   `vX.Y.Z`, and verifies `/health` reports that version.

### Rollback

```sh
fly releases -a marknotes --image                       # find the previous good image (e.g. label main-<sha> or vX.Y.Z)
fly deploy -a marknotes --ha=false --image registry.fly.io/marknotes:<label>
curl --fail https://marknotes.fly.dev/health             # confirm version/revision
```

Then revert or fix on `main`; the next push to `main` deploys again.

### Fly.io deployment and cost gate

This app needs **no database, Ecto, persistent volume or dedicated IPv4**. `fly.toml` uses a single shared-CPU 256 MB
Machine in `ams`, auto-start/stop, zero minimum running Machines, HTTPS and `/health`. Both workflows pass `--ha=false`
to avoid creating a spare Machine. The release container is non-root and contains no Node runtime.

**Fly.io has no general free tier for new organizations.** Auto-stop is not a zero-cost guarantee; active LiveView
connections may keep a Machine running, and runtime, stopped rootfs, builds and egress can be billed.
Confirm the organization's allowances and approve possible charges **before merging**, because main automatically
deploys. See [current pricing](https://docs.fly.io/about/pricing). A 256 MB container passed a limited five-session
LiveView/browser smoke check (about 130 MiB container usage with both public provider IDs configured). This is not a production load guarantee;
monitor memory after deployment and obtain approval before increasing the Machine size.

Once the [one-time setup](#one-time-setup) is done, do not recreate the app/registrations or rotate keys to deploy.
If the CLI cannot see `marknotes` or the repository deploy secret, restore the correct account/organization access
before continuing. Read-only checks and an explicitly authorized manual deployment:

```sh
fly status -a marknotes
fly secrets list -a marknotes
gh secret list -R MaxDac/marknotes-web
fly deploy --remote-only --ha=false -a marknotes
fly machine list -a marknotes
curl --fail https://marknotes.fly.dev/health
```

Do not race a manual deploy with the main/release workflow. After deployment, verify the expected release SHA,
HTTPS/LiveView startup, one Machine, and both provider sign-ins interactively in your own browser.
Use disposable notes in the same Android/desktop folder to verify a round-trip and that concurrent edits keep the newest
version plus a conflicted copy. Automated mock results must not be reported as real-account sign-in success.

| Secret | Where | Purpose |
| --- | --- | --- |
| `FLY_API_TOKEN` | GitHub repository secret | Deploy token (`fly tokens create deploy`) used by `deploy.yml`. |
| `SECRET_KEY_BASE` | Fly secret | Phoenix secret. |
| `DROPBOX_APP_KEY` | Optional Fly runtime override | Public Dropbox app key (PKCE, no secret). Unset uses the application default; explicit blank disables Dropbox. |
| `MSAL_CLIENT_ID` | Optional Fly runtime override | Public Microsoft Entra client ID. Unset uses the application default; explicit blank disables OneDrive. |

### Provider registrations

- **Dropbox**: app with "Full Dropbox" access and the scopes `account_info.read`, `files.metadata.read`,
  `files.content.read` and `files.content.write`. Redirect URIs: `https://marknotes.fly.dev/oauth/dropbox` and
  `http://localhost:4000/oauth/dropbox`.
- **OneDrive**: Entra app for personal and organizational accounts, with delegated `Files.ReadWrite` and `User.Read`, and a
  **Single-page application** platform with `https://marknotes.fly.dev/oauth/onedrive` and
  `http://localhost:4000/oauth/onedrive`.

For Dropbox, confirm the app's development-user restrictions or production access allow the intended users.
For Microsoft, confirm the registration accepts both personal and organizational accounts for the configured `common`
authority. Redirect/consent changes require access to the provider consoles; the web app cannot register them itself.

## Proton follow-up requirements (not implemented)

- every request must send `x-pm-appversion: external-drive-marknotes@0.1.0-alpha`;
- only official Proton endpoints are used, through the official [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk)
  (`@protontech/drive-sdk`). Any proposed server proxy may only forward to `https://drive-api.proton.me`;
- sync is event-based and runs only on load and on demand;
- no Proton logos or branding;
- the login screen states: "This is a third-party application not officially supported by Proton."

First establish browser SRP/TOTP, session refresh/address-key unlocking, SDK encrypted upload/download and event feeds.
API-supplied content-block URLs and the official guidelines' restrictions on endpoint proxying need a verified solution
before shipping a relay; do not broaden the host allow-list or implement Drive crypto from scratch.

Transport feasibility was checked on 2026-10-21: Chromium could read an unauthenticated request to
`https://drive-api.proton.me/auth/v4/info` from `http://localhost:4000`, but the same request from
`https://marknotes.fly.dev` failed CORS because the response did not allow that origin. The request used no user
credentials; this proves neither sign-in nor encrypted Drive access. The official SDK excludes authentication,
session management and address provisioning, and its guidelines prohibit modifying/proxying API endpoints to other
domains. Production browser support therefore remains blocked pending a compliant transport and authentication
solution; see [#1](https://github.com/MaxDac/marknotes-web/issues/1). No relay or working-looking Proton login is added.

## License

MarkNotes is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use is not permitted.
Third-party dependencies remain under their own licenses; esbuild emits bundled legal notices alongside built assets.
The Proton SDK is not bundled in this release. Its current published metadata reports MIT, not the previous README's
GPLv3 claim; verify the exact SDK/crypto versions and notices when implementing the follow-up.
