# MarkNotes note format

This format is shared by the MarkNotes apps ([Android](https://github.com/MaxDac/MarkNotes),
[desktop](https://github.com/MaxDac/marknotes-electron) and this web app). Notes and attachments written by one app
must be readable by the others through the same synced drive folder.

## Note ids (front-matter)

Each note is a UTF-8 `.md` file. A stable id is stored in a YAML front-matter block at the very top of the file:

```markdown
---
id: k7f3q2xa
---
Note body…
```

- The id has 8 characters, chosen at random from the lowercase Crockford base32 alphabet
  `0123456789abcdefghjkmnpqrstvwxyz` (no `i`, `l`, `o` or `u`).
- New notes get an id when they are created. A note without an id (a legacy note, or one written by another tool) gets
  one lazily: when it is opened in the editor, or when the `@` popup needs to list it. The id is written back through
  the normal save path, so it syncs like any other edit.
- Any other front-matter keys are kept verbatim; only the `id:` line is added or replaced.
- The front-matter is hidden in the editor and preview: you edit only the body, and the header is re-attached on save.
- The id stays the same when the note is renamed or moved, so links keep working.
- **Duplicate ids** (for example when a file is copied): links resolve to the first note by sorted path (code-point
  order). When an app notices a duplicate locally, it gives the later note a new id. A `(conflicted copy)` note gets
  a new id too, so links keep pointing at the original.

## Note links

A link to another note uses the `marknotes:` scheme with the note id:

```markdown
[Project plan](marknotes:k7f3q2xa)
```

The link text is free; when a link is inserted from the `@` popup, it is the note's title (its file name without
`.md`). In the preview, clicking the link opens the note. If no note has that id, the link is shown as broken and
clicking it reports **Note not found**.

In the editor, typing `@` at the start of a line or after whitespace opens a panel at the bottom of the editor. It lists
every note with its title, full path (`Folder/Subfolder/Title`) and id, which has a copy button. Text typed after `@`
filters the list by id prefix, or by a case-insensitive match in the title or path. Use the arrow keys to move, and
Enter or a click to insert the link in place of `@query`. Esc closes the panel; so does typing a space when nothing
matches.

## Images (attachments)

Images are stored once, at the **root** of the notes folder:

```
attachments/<sha256>.<ext>
```

- `<sha256>` is the lowercase hex SHA-256 of the final, stored bytes; `<ext>` is `png`, `jpg`, `gif` or `webp`, taken
  from the MIME type. Other image types are rejected.
- Before storing, images are downscaled so that the longest side is at most 2048 px, keeping their format. GIFs are
  stored untouched. Images larger than 10 MB after processing are rejected with a message.
- The inserted markdown is `![<original file name without extension>](attachments/<sha256>.<ext>)`. The path is
  always resolved from the notes root, whatever folder the note is in.
- Images can be added with the toolbar **Insert image** button, by pasting, or by drag-and-drop into the editor.
- The `attachments/` folder is hidden from the note tree, and `attachments` cannot be used as a root note or folder
  name.
- **Settings → Clean unused images** scans every note for `attachments/…` references and deletes unreferenced
  attachment files locally; the deletion reaches the drives on the next sync. Cleanup never runs automatically.

The web app keeps attachments in IndexedDB. Its preview only shows images from `attachments/`, loaded locally as
`blob:` URLs; remote images are still never loaded.

## Attachment sync

Files under `attachments/` sync to **every** linked drive, like notes, and are listed in `.marknotes/manifest.json`
with their `sha256` (the manifest stays `format: 1`). They are binary and immutable, because the name is the content
hash:

- they are only uploaded, downloaded or deleted, never three-way merged, and they never produce conflicted copies;
- a download whose content does not match the hash in its name is rejected;
- deletions propagate in both directions, like notes.
