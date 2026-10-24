# Security model

How MarkNotes Web protects notes, why they are not kept on the server, and what it does not protect against.
The public summary is the script-free page at [`/security`](../lib/marknotes_web/controllers/page_html/security.html.heex)
(linked from Settings › Privacy and security, the sidebar and the unlock screen). Keep the two in sync and describe
only measures that ship.

## Assets and threats

| Asset | Where it lives |
| --- | --- |
| Note text, note/folder names, images | Browser (IndexedDB or memory), the user's drives |
| Drive OAuth tokens (Dropbox refresh token, Microsoft tokens) | Browser credential store; MSAL keeps its own cache in memory |
| Sync state (per-drive records, three-way-merge base copies, cursors) | Browser, next to the notes |
| App code | Served by Phoenix (Fly.io) |

Threats considered: a breached or malicious server; another person or malware reading the browser profile on disk
(shared, lost or stolen device, backups); script injection into the page (XSS via note content, dependencies);
network attackers; tampering with stored data; exfiltration to unexpected hosts.

## Options considered

The question was whether notes should move from IndexedDB to the server, for example an in-memory Erlang (ETS) cache
like the one used by Privee, fed by LiveView.

| Option | Server breach | Device at rest | XSS | Notes |
| --- | --- | --- | --- | --- |
| A. Browser IndexedDB, plaintext (before this change) | Nothing stored | **Readable** | Readable | Tokens encrypted, but key stored beside them |
| B. Server ETS cache, plaintext | **Every user's notes and tokens** | Nothing stored | Readable (page renders them) | Server must hold provider tokens to sync; lost on restart/auto-stop |
| C. Server ETS cache of client-encrypted data | Ciphertext only | Nothing stored | Readable | Equivalent to A with encryption, plus a server that adds nothing |
| **D. Hardened browser storage (chosen)** | Nothing stored | Encrypted (passphrase) or absent (memory only) | Readable while unlocked | No new server-side data |

Why not B: an ETS table is plaintext in the BEAM's memory. Any remote code execution, `:observer`/remote shell access,
crash dump or core dump exposes all users at once, and the server would also have to hold every user's drive tokens to
sync. Fly.io machines `auto_stop` and run one 256 MB instance, so the cache would be lost and would cap total note
size. LiveView would add per-keystroke round trips. B centralises the most valuable data; A and D spread it across
devices, where one compromise affects one user.

Why Privee's pattern does not transfer: Privee keeps Signal-protocol **ciphertext** in ETS. The server never has the
keys, so it cannot read what it relays. Option C is that design applied to notes. It protects at the server only
because the server learns nothing, which is already true of the browser-only design. It would add a new service and a
new metadata leak without new protection.

Residual risk shared by every option: users trust the server to deliver unmodified app code. A compromised server could
send a script that reads notes in browsers that load it afterwards. D keeps that from also being a stored-data breach.

## Measures

### Storage modes (`assets/js/security.ts`, `assets/js/backend.ts`)

Chosen in Settings › Privacy and security. The mode is stored in the IndexedDB `meta` store.

- **plain** (default): IndexedDB as before (`notes`, `attachments`, `values`). Credentials are encrypted with a
  non-extractable AES-GCM `vault-key` stored in `values`. This protects against reading tokens directly from storage
  files, not against code running in the origin.
- **locked** (passphrase):
  - The passphrase goes through PBKDF2-SHA-256 with 600,000 iterations and a 16-byte random salt. The resulting key
    AES-GCM-encrypts a random 32-byte root secret (AAD `marknotes:root:1`). Changing the passphrase re-wraps only the
    root secret.
  - HKDF-SHA-256 derives three non-extractable keys from the root: `data` (AES-256-GCM), `ids` (HMAC-SHA-256) and
    `vault` (AES-256-GCM).
  - Every record (each note, image, value, sync record and base copy) is stored in the `sealed` store:
    - Its key is `base64url(HMAC(ids, store ‖ 0x00 ‖ key))`, so names and paths are not on disk.
    - Its value is AES-GCM with a random 96-bit IV and the record id as AAD.
  - Loading verifies each id against the decrypted content, so swapped or altered records are refused.
  - The plaintext stores are cleared in the same transaction that writes the sealed copy.
  - While unlocked, the working set is decrypted into memory (`MemoryBackend`). Each committed change is sealed and
    written before it is applied in memory, so a failed write leaves both unchanged. Sealing happens outside
    IndexedDB transactions because those auto-commit across WebCrypto awaits.
  - Credentials inside the working set are encrypted with the `vault` key.
  - The app locks after an idle time chosen in Settings (off, 5, 15 or 60 minutes; default 15, kept in the sealed
    store), or on demand, by saving and reloading the page, which drops the memory.
- **ephemeral** (memory only): a `MemoryBackend` that never persists anything. Credentials use a random per-tab key. Switching to it
  deletes everything stored locally; drives keep their copies.

Memory-backed modes need one tab: the `marknotes:session` Web Lock is exclusive in `locked`/`ephemeral` and shared
in `plain`. Switching modes requires that no other MarkNotes tab is open. Switches migrate every record and re-encrypt
credentials, except device-local keys.

**Forget this device** (Settings, and the unlock screen) deletes the IndexedDB database and clears localStorage,
sessionStorage and Cache Storage for the origin. It does not touch the drives. Disconnecting the **last** drive offers
the same deletion as a checkbox, **Also delete the notes stored on this device** (unticked by default), mirroring the
desktop app.

### Network and page hardening

- CSP `connect-src` (`lib/marknotes_web/privacy_headers.ex`) is limited to:
  - `'self'` and the LiveView socket origin;
  - `api.dropboxapi.com` and `content.dropboxapi.com`;
  - `graph.microsoft.com` and `login.microsoftonline.com`;
  - the OneDrive download hosts `*.1drv.com`, `*.microsoftpersonalcontent.com` and `*.sharepoint.com`.

  Before this change it allowed any `https:`, `ws:` or `wss:` host. `providers.ts` refuses OneDrive download URLs
  outside the same host list, and never sends the Graph token to them.
- Other CSP rules:
  - `script-src 'self' 'wasm-unsafe-eval'`: no inline scripts, no `eval`.
  - `img-src 'self' data: blob:` and `font-src 'self'`.
  - `object-src 'none'`, `base-uri 'none'` and `form-action 'none'`.
  - `frame-ancestors 'self'`.
- Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a
  `Permissions-Policy` that denies camera, microphone, geolocation, payment, USB and the other device/sensor APIs.
- The Phoenix session cookie is `HttpOnly` and, in production, `Secure` (`secure_cookie: false` only in dev and test,
  which are served over plain http). It holds only the CSRF token, never note data.
- The preview is sanitised with DOMPurify. It shows no raw HTML and no remote images, only local `attachments/` as
  `blob:` URLs.
- OAuth: Dropbox uses PKCE and Microsoft uses MSAL.js with a memory cache, both in a popup. The callback page contains
  no request data, and Phoenix filters `code`, `state` and `token` from logs.

## Residual risks

- **XSS, malicious extensions or malware** see whatever the unlocked page sees. CSP and sanitising reduce the risk of
  XSS. Trusted Types is not enabled yet: the UI builds markup with `innerHTML` and LiveView patches the DOM. Moving
  to Trusted Types would need a policy for those sinks and is future work.
- **Drives are not end-to-end encrypted.** The providers can read synced notes. Encrypting files on the drive would
  change the shared format (Android and desktop read the same folder) and must start in marknotes-spec.
- **Metadata at rest (locked mode):** the number and sizes of sealed records are visible.
- **Remnants:** plaintext written before a passphrase was set may survive in the browser's storage files (LevelDB/SQLite
  pages) until compaction.
- **Passphrase loss** cannot be recovered. The user forgets the device and re-syncs from the drives, losing unsynced
  changes. PBKDF2 slows offline guessing but a weak passphrase is still guessable; the minimum length is 10 characters.
- **Memory:** JavaScript cannot reliably wipe strings. Decrypted notes may stay in the tab's heap until garbage
  collection; locking reloads the page to drop the whole heap.
- **App code integrity** depends on the server and its supply chain, as for any web app.

## Tests

- `assets/tests/security.test.ts`:
  - Sealed data contains no plaintext, names or tokens.
  - Unlock and wrong passphrase; passphrase change.
  - Tamper detection.
  - Mode migrations keep notes and credentials.
  - Memory-only storage writes nothing and allows a single tab.
  - Forget device.
- `assets/tests/providers.test.ts`: OneDrive download host allowlist.
- `test/marknotes_web/controllers/page_controller_test.exs`: CSP `connect-src`, `Permissions-Policy`, the session
  cookie flags and the `/security` page.
- `assets/e2e/security.spec.ts`: passphrase lock and unlock, the auto-lock choice, memory-only mode, forget device,
  deleting local notes when disconnecting the last drive, and the security page link.
