# MarkNotes note format

The note, link, attachment, manifest and merge format shared by the MarkNotes apps
([Android](https://github.com/MaxDac/MarkNotes), [desktop](https://github.com/MaxDac/marknotes-electron) and this web
app) is specified in [MaxDac/marknotes-spec](https://github.com/MaxDac/marknotes-spec):

- [`note-format.md`](https://github.com/MaxDac/marknotes-spec/blob/main/note-format.md) — the canonical format
  (also at [`spec/note-format.md`](../spec/note-format.md) in this repository's `spec/` git submodule);
- [`features.md`](https://github.com/MaxDac/marknotes-spec/blob/main/features.md) — the feature parity matrix and known
  divergences between the apps;
- `fixtures/` — golden test cases, run against this app by `cd assets && npm run parity` and the
  "Parity (marknotes-spec fixtures)" CI job.

Change the format in marknotes-spec first, then bump the submodule here (see [AGENTS.md](../AGENTS.md)).
