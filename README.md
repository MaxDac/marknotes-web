# MarkNotes Web

Web markdown notes app built with Phoenix LiveView, with folders and sync to Proton Drive (unofficial), Dropbox and
OneDrive. It is the web sibling of the Android app [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes) and the desktop app
[MaxDac/marknotes-electron](https://github.com/MaxDac/marknotes-electron). It has the same features and the same sync format.

Live at <https://marknotes-web.fly.dev>.

> **This is a third-party application not officially supported by Proton.**
> MarkNotes is a personal, non-commercial project. It is not affiliated with or endorsed by Proton AG,
> and it does not use any Proton logos or branding.

> **Status:** bootstrap. The app is being implemented. See the planned features below.

## Features (planned, parity with Android)

- **Notes stay in your browser**: stored in IndexedDB as a tree of folders and `.md` notes. You can create, open, rename,
  delete and move notes and folders, and a sidebar shows the folder tree. Note content is never sent to the MarkNotes server.
  The UI needs a live server connection (LiveView), but your data persists locally.
- **Editor**: raw markdown (CodeMirror 6) with a client-side preview (tables, strikethrough, task lists, highlighted code
  blocks). It has a formatting toolbar, continues lists, checkboxes and quotes on Enter, and autosaves.
- **Appearance**: theme System, Light or Dark, and an accent colour from 8 palettes.
- **Multi-drive two-way sync** with any number of Proton Drive, Dropbox and OneDrive accounts. Sync runs in the browser,
  on load and on **Sync now**. It keeps the `.marknotes/manifest.json` manifest and merges lines three-way. Conflicts are
  resolved per change: Mine, Theirs, Both, Neither, or edit by hand.
- **Proton login**: SRP password login with TOTP, computed in the browser. Proton doesn't allow cross-origin browser
  requests, so the server relays Proton API calls through `/proton-api/*`. It is a thin, allow-listed pass-through to
  `https://drive-api.proton.me`. Your password never leaves the browser, and Drive content is end-to-end encrypted.
- **Dropbox / OneDrive login**: OAuth 2 PKCE (Dropbox) and MSAL.js (OneDrive), called directly from the browser.
- Tokens are stored in IndexedDB, encrypted with a non-extractable WebCrypto key.

Out of scope: search, tags, attachments, background sync, offline UI, local encryption.

## Development

Requirements: the Erlang, Elixir and Node.js versions in `.tool-versions` (asdf/mise).

```sh
mix setup                      # deps + assets
mix phx.server                 # http://localhost:4000
mix format --check-formatted && mix credo --strict && mix test
mix dialyzer
(cd assets && npm run check)   # prettier, tsc, eslint, vitest
(cd assets && npm run e2e)     # Playwright (starts the server itself)
```

## CI/CD

- `checks.yml` (reusable) has five required checks: "Elixir (compile, format, credo, test)", "Dialyzer",
  "Assets (prettier, tsc, eslint, vitest)", "Browser E2E (Playwright)" and "Docker image build".
- `pr-ci.yml` runs them on pull requests. `fly.yml` runs them on every push to `main` and deploys to Fly.io if they pass.
- `release.yml` is started manually with a `version` (`X.Y.Z`) and a `prerelease` flag. It runs the checks, publishes the
  `vX.Y.Z` GitHub Release and deploys that commit to Fly.

### Fly.io setup (once)

```sh
fly apps create marknotes-web
fly secrets set SECRET_KEY_BASE=$(mix phx.gen.secret) DROPBOX_APP_KEY=... MSAL_CLIENT_ID=... -a marknotes-web
fly tokens create deploy -a marknotes-web   # store it as the FLY_API_TOKEN repository secret
```

| Secret | Where | Purpose |
| --- | --- | --- |
| `FLY_API_TOKEN` | GitHub repository secret | Deploy token used by `fly.yml` and `release.yml`. |
| `SECRET_KEY_BASE` | Fly secret | Phoenix secret. |
| `DROPBOX_APP_KEY` | Fly secret | Dropbox app key (PKCE, no secret). Optional; without it Dropbox shows as not configured. |
| `MSAL_CLIENT_ID` | Fly secret | Microsoft Entra application (client) ID. Optional; without it OneDrive shows as not configured. |

### Provider registrations

- **Dropbox**: app with "Full Dropbox" access and the scopes `account_info.read`, `files.metadata.read`,
  `files.content.read` and `files.content.write`. Redirect URIs: `https://marknotes-web.fly.dev/oauth/dropbox` and
  `http://localhost:4000/oauth/dropbox`.
- **OneDrive**: Entra app for personal and organizational accounts, with delegated `Files.ReadWrite` and `User.Read`, and a
  **Single-page application** platform with `https://marknotes-web.fly.dev/oauth/onedrive` and
  `http://localhost:4000/oauth/onedrive`.

## Proton API usage rules

- every request sends `x-pm-appversion: external-drive-marknotes@0.1.0-alpha`;
- only official Proton endpoints are used, through the official [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk)
  (`@protontech/drive-sdk`). The server proxy only forwards to `https://drive-api.proton.me`;
- sync is event-based and runs only on load and on demand;
- no Proton logos or branding;
- the login screen states: "This is a third-party application not officially supported by Proton."

## License

MarkNotes is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use is not permitted.
Third-party dependencies remain under their own licenses. The Proton Drive SDK is GPLv3.
