## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] `mix format --check-formatted && mix credo --strict && mix test && mix dialyzer` passes locally
- [ ] `cd assets && npm run check && npm run e2e` passes locally
- [ ] Sync changes are covered by sync engine tests (against the fake remote drive store)
- [ ] Manifest format still compatible with the Android app (`.marknotes/manifest.json`, format 1)
- [ ] Note content never reaches the server; the Proton proxy still only forwards allow-listed paths to `drive-api.proton.me`
- [ ] Proton requirements still met (`x-pm-appversion` header, official endpoints only, no Proton branding, third-party disclaimer on login)
