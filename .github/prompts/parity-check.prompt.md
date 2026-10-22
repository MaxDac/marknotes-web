---
mode: agent
description: Audit a feature across the MarkNotes web, Android and desktop apps against marknotes-spec
---

Audit cross-app parity for the MarkNotes feature: **${input:feature:Feature to audit, e.g. note links}**.

The apps share one synced drive folder and one note format:

- Web: MaxDac/marknotes-web (this repo when run here) — Phoenix + browser TypeScript, logic in `assets/js/`.
- Android: MaxDac/MarkNotes — Kotlin/Gradle.
- Desktop: MaxDac/marknotes-electron — Electron/TypeScript.
- Spec: MaxDac/marknotes-spec — `note-format.md`, `features.md` (parity matrix), `fixtures/<area>/*.json`
  (`{description, cases: [{name, input, expected, knownDivergence?}]}`). Available locally as the `spec/` submodule
  when present (`git submodule update --init spec`); otherwise read it with `gh`.

Steps (read-only; do not modify sibling repos):

1. **Spec.** Find the feature in `spec/features.md` and `spec/note-format.md` (or
   `gh api repos/MaxDac/marknotes-spec/contents/<path> --jq .content | base64 -d`). Note the expected behaviour, the
   status per app, and the related fixture files and any `knownDivergence` entries.
2. **Each app.** For this repo and each sibling, locate the implementation and tests. Use local search here; for
   siblings use `gh search code --repo MaxDac/<repo> '<term>'`, `gh api repos/MaxDac/<repo>/contents/<path>`, or a
   shallow clone into a temp dir (`gh repo clone MaxDac/<repo> <tmp> -- --depth 1`). Check the default branch `main`.
3. **Compare** against the spec: data format on disk/drive (front-matter, ids, links, `attachments/` names,
   `.marknotes/manifest.json` format 1), validation rules, conflict handling, edge cases covered by fixtures, UI
   entry points, and whether fixtures are run in each app's CI (`Parity (marknotes-spec fixtures)` job).
4. **Report** in this shape, citing file paths/links for every claim:

   | Aspect | Spec | Web | Android | Desktop | Gap / risk |
   | --- | --- | --- | --- | --- | --- |

   Then list: (a) gaps that can break interoperability (data written by one app misread by another) — highest
   priority; (b) behaviour/UI gaps; (c) missing tests or fixtures; (d) undocumented divergences that should become
   `knownDivergence` or a `features.md` update. Suggest the concrete follow-up per repo (spec first, then apps).

If something cannot be determined, say so explicitly instead of guessing.
