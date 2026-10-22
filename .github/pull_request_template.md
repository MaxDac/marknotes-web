## Summary

<!-- What does this PR change and why? -->

## Parity impact

<!-- Does this touch the shared contract with the Android (MaxDac/MarkNotes) and desktop (MaxDac/marknotes-electron)
apps: note format/front-matter ids, `marknotes:` links, `attachments/`, `.marknotes/manifest.json`, conflict handling,
path validation or sync layout? See AGENTS.md > Cross-app parity rules. -->

- [ ] None — web-only change
- [ ] Shared contract affected — spec PR in MaxDac/marknotes-spec: <!-- link -->
- [ ] Mirrored (or tracked) in Android: <!-- PR/issue link --> and desktop: <!-- PR/issue link -->
- [ ] Intentional divergence recorded as `knownDivergence.web` in the spec fixtures / `features.md`

## Checklist

- [ ] `mix format --check-formatted && mix credo --strict && mix test && mix dialyzer` passes locally
- [ ] `mix hex.audit && mix deps.audit && mix sobelow --config` passes locally
- [ ] `cd assets && npm run check && npm run e2e` passes locally
- [ ] Sync changes are covered by sync engine tests (against the fake remote drive store)
- [ ] Manifest format still compatible with the Android app (`.marknotes/manifest.json`, format 1)
- [ ] Note content never reaches the server; the Proton proxy still only forwards allow-listed paths to `drive-api.proton.me`
- [ ] Proton requirements still met (`x-pm-appversion` header, official endpoints only, no Proton branding, third-party disclaimer on login)
