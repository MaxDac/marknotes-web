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
- **Appearance**: theme System, Light or Dark, and an accent colour from 8 palettes.
- **Multi-drive two-way sync** with any number of Dropbox and OneDrive accounts. Sync runs in the browser,
  on load and on **Sync now**. It keeps the `.marknotes/manifest.json` manifest and merges lines three-way. Conflicts are
  resolved per change: Mine, Theirs, Both, Neither, or edit by hand.
- **Dropbox / OneDrive login**: OAuth 2 PKCE (Dropbox) and MSAL.js (OneDrive), called directly from the browser in popups.
- Persisted app-held tokens are stored in IndexedDB, encrypted with a non-extractable AES-GCM WebCrypto key. MSAL's own
  cache stays in memory, not plaintext local/session storage. After reload, the saved access token remains usable until
  expiry; Microsoft SSO is attempted for renewal, and **Reconnect** is required if third-party-cookie/session restrictions
  prevent silent sign-in. No unsupported MSAL cache serialization is used.

Out of scope: search, tags, attachments, background sync, offline UI, local note encryption.

### Notes and cloud folders

Use **New folder** / **New note** in the selected folder. **Rename / move** accepts a path relative to the local root.
Notes must end in `.md`; hidden names, traversal and moves into a folder's own descendants are rejected.
The editor saves automatically and flushes before navigation or sync. Wait for **Saved in this browser** before closing
the tab; a failed/stale save leaves the text in the editor and displays an error.

Connect a drive and browse to the same folder used by Android/desktop. By default the picker creates/uses a `MarkNotes`
child folder; uncheck that option to sync the selected folder itself. A new connection is reconciled with **Sync now**.
All accounts mirror the same local tree; they are not independent notebooks. Disconnect removes only that connection's
local credentials/history, not local notes or provider-side app authorization.

Sync follows initial listings with Dropbox cursors / Microsoft Graph delta feeds, not background polling. Per-drive
base content and sync records persist locally. The remote `.marknotes/manifest.json` has `format: 1`, `app: "MarkNotes"`,
device ID, epoch-millisecond timestamps and path-keyed `sha256`/`version`/`syncedAt` entries. Identical content is recognized
by SHA-256; non-overlapping edits merge against the last synced base. Edits survive opposing deletions.
Without a base, differing content requires explicit resolution. **Both** concatenates a conflicting hunk;
**Keep both files** creates a unique ` (conflicted copy).md` sibling. Unresolved conflicts persist across reload.
Three reconciliation passes per drive bound a multi-drive run; errors and incomplete convergence are reported.

### Privacy and durability

Notes, paths, provider tokens and editing events are not sent to Phoenix or stored in server sessions.
Cloud API calls go directly to the provider. OneDrive preauthenticated download URLs receive no Graph bearer header.
Markdown preview disables embedded images, raw HTML and unsafe links; code blocks are highlighted locally.
OAuth callbacks are minimal client pages, not LiveViews, and authorization parameters are filtered from Phoenix logs.
The encryption key is non-extractable but is stored beside the encrypted credentials: it does **not** defend against
same-origin XSS or protect plaintext notes. Clearing site data/browser profiles removes notes and credentials; there is
no server-side recovery. Private browsing may limit storage. WebCrypto, IndexedDB and Web Locks support are required
(secure HTTPS, or localhost). Concurrent stale edits fail visibly instead of silently overwriting a newer note.

## Development

Requirements: the Erlang, Elixir and Node.js versions in `.tool-versions` (asdf/mise).

```sh
mix setup                      # deps + assets
mix phx.server                 # http://localhost:4000
DROPBOX_APP_KEY=... MSAL_CLIENT_ID=... mix phx.server
mix format --check-formatted && mix credo --strict && mix test
mix dialyzer
(cd assets && npm run check)   # prettier, tsc, eslint, vitest
(cd assets && npm run e2e)     # Playwright (starts the server itself)
```

`config/runtime.exs` reads both public client IDs at runtime; neither is baked into the asset bundle.
Missing/blank IDs disable that provider with **not configured**. `SECRET_KEY_BASE` is mandatory in production.
After changing client assets, run `mix assets.build` (or `cd assets && npm run build`); no asset watcher is required.
Make sure the version-manager shims precede Windows executables on WSL (`asdf exec mix`, `asdf exec npm` if needed).

Install the E2E browser once: `cd assets && npx playwright install --with-deps chromium`.
Playwright supplies a fake public Dropbox ID, uses network fixtures (not real accounts), and starts its own server.
The OneDrive browser fixture seeds encrypted credentials and exercises Graph downloads, conditional updates and conflicts;
MSAL configuration/login is covered with an SDK mock. These tests do not prove real provider registration/consent.
If the host cannot install browser libraries, an isolated matching Playwright browser server can be used with
`PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:3030/ npm run e2e`; the Phoenix server still starts locally.

To reproduce production-mode E2E, set `MIX_ENV=prod`, `PHX_HOST=localhost`, `PORT=4000` and a throwaway `SECRET_KEY_BASE`,
then run `mix deps.get --only prod && mix compile && mix assets.deploy` before `cd assets && npm run e2e`.

## CI/CD

- `checks.yml` (reusable) has five required checks: "Elixir (compile, format, credo, test)", "Dialyzer",
  "Assets (prettier, tsc, eslint, vitest)", "Browser E2E (Playwright)" and "Docker image build".
- `pr-ci.yml` runs them on pull requests, plus "Dependency review" (fails on high-severity vulnerable dependencies) and
  "actionlint" (workflow lint, including shellcheck of `run:` scripts).
- `codeql.yml` runs CodeQL for `javascript-typescript` and `actions` on pull requests, pushes to `main` and weekly
  (Elixir is not supported by CodeQL).
- `dependabot-automerge.yml` enables squash auto-merge for Dependabot semver patch/minor updates; majors stay manual.
  Requires "Allow auto-merge" in the repository settings; merges still wait for the required checks.
- `fly.yml` runs the checks on every push to `main` and deploys to Fly.io if they pass.
- `release.yml` is started manually with a `version` (`X.Y.Z`) and a `prerelease` flag. It runs the checks, publishes the
  `vX.Y.Z` GitHub Release and deploys that commit to Fly.
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

Supply the public `DROPBOX_APP_KEY` and `MSAL_CLIENT_ID` as runtime Fly secrets through
`fly secrets import --stage -a marknotes` (stdin `NAME=VALUE` pairs); no provider client secrets are needed.
Without those IDs, the corresponding provider visibly shows **not configured**. Generate `SECRET_KEY_BASE` only for
initial setup; preserve it on subsequent deployments.

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
Use disposable notes in the same Android/desktop folder to verify a round-trip, non-overlapping merge and conflict
resolution. Automated mock results must not be reported as real-account sign-in success.

| Secret | Where | Purpose |
| --- | --- | --- |
| `FLY_API_TOKEN` | GitHub repository secret | Deploy token (`fly tokens create deploy`) used by `deploy.yml`. |
| `SECRET_KEY_BASE` | Fly secret | Phoenix secret. |
| `DROPBOX_APP_KEY` | Fly secret | Dropbox app key (PKCE, no secret). Optional; without it Dropbox shows as not configured. |
| `MSAL_CLIENT_ID` | Fly secret | Microsoft Entra application (client) ID. Optional; without it OneDrive shows as not configured. |

### Provider registrations

- **Dropbox**: app with "Full Dropbox" access and the scopes `account_info.read`, `files.metadata.read`,
  `files.content.read` and `files.content.write`. Redirect URIs: `https://marknotes.fly.dev/oauth/dropbox` and
  `http://localhost:4000/oauth/dropbox`.
- **OneDrive**: Entra app for personal and organizational accounts, with delegated `Files.ReadWrite` and `User.Read`, and a
  **Single-page application** platform with `https://marknotes.fly.dev/oauth/onedrive` and
  `http://localhost:4000/oauth/onedrive`.

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

## License

MarkNotes is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use is not permitted.
Third-party dependencies remain under their own licenses; esbuild emits bundled legal notices alongside built assets.
The Proton SDK is not bundled in this release. Its current published metadata reports MIT, not the previous README's
GPLv3 claim; verify the exact SDK/crypto versions and notices when implementing the follow-up.
