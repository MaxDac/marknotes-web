import { type EditorView } from "@codemirror/view";
import { Auth, type PublicConfig } from "./auth";
import {
  createEditor,
  format,
  insert,
  type Mention,
  preview,
  setEditorEditable,
} from "./editor";
import {
  ACCEPTED_TYPES,
  imageMarkdown,
  inAttachments,
  mimeFor,
  processImage,
  referencedAttachments,
} from "./attachments";
import {
  filterRefs,
  noteBody,
  noteLink,
  noteRefs,
  type NoteRef,
  withBody,
} from "./notemeta";
import {
  Store,
  type Note,
  type Account,
  exclusive,
  join,
  parent,
  validateName,
  isNote,
} from "./storage";
import { drive, type Drive } from "./providers";
import { syncAll, message } from "./sync";
import {
  addConflicts,
  applyMerge,
  discardCopy,
  keepBoth,
  loadMerge,
  mergeView,
  pendingConflicts,
  type SyncConflict,
} from "./conflicts";
import {
  CHORD_SETTING,
  chordLineEnding,
  isChordSequence,
  needsChordOptIn,
  newChordSequenceText,
  parseChordBody,
  serializeChordBody,
  type ChordSequence,
} from "./chords";
import { ChordEditor } from "./chord-editor";
import {
  ask,
  button,
  checked,
  confirmDialog,
  element,
  icon,
  type IconName,
  logo,
  menu,
  openDialog,
  segmented,
  showError,
  toggle,
} from "./components";

const palettes: Record<string, string> = {
  violet: "#6d4aff",
  blue: "#2563eb",
  teal: "#0d9488",
  green: "#16a34a",
  amber: "#b7791f",
  orange: "#ea580c",
  red: "#dc2626",
  pink: "#db2777",
  purple: "#9333ea",
};
const providerNames: Record<Account["provider"], string> = {
  dropbox: "Dropbox",
  onedrive: "OneDrive",
};
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const formatting: [string, IconName | string, string, string][] = [
  ["Bold", "B", "**", "**"],
  ["Italic", "I", "*", "*"],
  ["Heading", "H", "## ", ""],
  ["Link", "link", "[", "](https://)"],
  ["Code", "code", "`", "`"],
  ["Code block", "block", "```\n", "\n```"],
  ["List", "list", "- ", ""],
  ["Checklist", "checklist", "- [ ] ", ""],
  ["Quote", "quote", "> ", ""],
];

export class NotesUI {
  private store!: Store;
  private auth!: Auth;
  private editor!: EditorView;
  private chordEditor?: ChordEditor;
  /** The user chose "View as text" for the open chord sequence. */
  private textView = false;
  /** Settings → Chord sequences: off by default, stored only in this browser. */
  private chordsEnabled = false;
  private current?: Note;
  private selected = "";
  private dirty = false;
  private loading = false;
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private remotes = new Map<string, Drive>();
  private collapsed = new Set<string>();
  private health = new Map<string, "ok" | "error">();
  private media = matchMedia("(prefers-color-scheme: dark)");
  private theme = "system";
  private accent = "violet";
  private disposed = false;
  private mediaListener = () => this.applyTheme();
  private refs: NoteRef[] = [];
  private urls = new Map<string, string>();
  private mention: Mention | null = null;
  private matches: NoteRef[] = [];
  private active = 0;
  private dismissed?: number;
  private idsReady?: Promise<void>;
  private errorListener = (e: Event) =>
    this.error(String((e as CustomEvent<unknown>).detail));
  private unloadListener = (event: BeforeUnloadEvent) => {
    if (this.dirty || this.chordEditor?.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  constructor(
    private root: HTMLElement,
    private config: PublicConfig,
  ) {}
  private get<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`Missing UI element ${selector}`);
    return el;
  }
  async start(): Promise<void> {
    this.store = await Store.open();
    if (this.disposed) {
      this.store.close();
      return;
    }
    this.auth = new Auth(this.store, this.config);
    this.root.innerHTML = `
      <p id="connection" class="banner" role="status"></p>
      <fieldset id="workspace" class="app">
        <legend class="sr-only">Notes workspace</legend>
        <aside class="sidebar" id="sidebar">
          <div class="brand"><span class="wordmark">MarkNotes</span></div>
          <div id="new-slot" class="new-slot"></div>
          <nav class="locations" aria-label="Locations"></nav>
          <nav id="tree" class="tree" aria-label="Folders and notes"></nav>
          <section class="drives" aria-labelledby="drives-title">
            <h2 id="drives-title" class="section-title">Drives</h2>
            <div id="accounts" class="accounts"></div>
            <div id="connect" class="connect"></div>
            <p class="hint">Proton Drive - planned. This is a third-party application not officially supported by Proton.</p>
          </section>
          <p class="local"></p>
        </aside>
        <div class="scrim" aria-hidden="true"></div>
        <div class="main" id="main">
          <header class="topbar">
            <div id="menu-slot" class="menu-slot"></div>
            <h1 id="title" class="breadcrumb"></h1>
            <span id="status" class="status" role="status" aria-live="polite">Ready</span>
            <div id="top-actions" class="top-actions"></div>
          </header>
          <div class="toolbar">
            <nav id="formatting" class="formatting" aria-label="Formatting"></nav>
            <div id="mode-slot" class="mode-slot"></div>
            <div id="item-actions" class="item-actions"></div>
          </div>
          <p id="chord-banner" class="chord-banner" role="status" hidden></p>
          <section id="empty" class="empty"></section>
          <div class="panes">
            <div class="pane editor-pane">
              <div id="editor"></div>
              <div id="mentions" class="mentions" role="listbox" aria-label="Link to a note" hidden></div>
            </div>
            <article id="preview" class="pane preview" aria-label="Markdown preview"></article>
          </div>
          <section id="chord-pane" class="chord-pane" aria-label="Chord editor"></section>
        </div>
      </fieldset>
      <div id="error" class="toast" role="alert" hidden></div>`;
    this.get(".brand").prepend(logo());
    this.get(".local").append(
      icon("lock"),
      element("span", "Notes are stored only in this browser"),
    );
    this.editor = createEditor(
      this.get("#editor"),
      (text) => {
        if (this.loading || !this.current) return;
        this.dirty = true;
        this.renderPreview(text);
        this.scheduleSave();
      },
      {
        mention: {
          update: (mention) => this.updateMention(mention),
          key: (key) => this.mentionKey(key),
        },
        files: (files, position) => void this.insertImages(files, position),
      },
    );
    this.get("#preview").addEventListener("click", (event) => {
      const link = (event.target as Element).closest<HTMLElement>(
        "a[data-note-id]",
      );
      if (!link) return;
      event.preventDefault();
      const ref = this.refs.find((r) => r.id === link.dataset.noteId);
      if (ref) void this.run(() => this.open(ref.path));
      else
        this.error(
          "Note not found. It may have been deleted or not synced yet.",
        );
    });
    const picker = element("input", undefined, "sr-only");
    picker.type = "file";
    picker.accept = ACCEPTED_TYPES.join(",");
    picker.multiple = true;
    picker.tabIndex = -1;
    picker.setAttribute("aria-hidden", "true");
    picker.id = "image-file";
    picker.addEventListener("change", () => {
      const files = [...(picker.files ?? [])];
      picker.value = "";
      if (files.length) void this.insertImages(files, null);
    });
    this.setEditable(false);
    this.chordEditor = new ChordEditor({
      onChange: (sequence) => this.chordsChanged(sequence),
      status: (text) => this.status(text),
    });
    this.get("#chord-pane").append(this.chordEditor.root);
    this.get("#mode-slot").append(
      button("View as text", () => void this.toggleView(), {
        icon: "code",
        variant: "outline",
        id: "view-mode",
      }),
    );
    const act = (action: () => Promise<void>) => () => {
      void this.run(action);
    };
    this.get("#new-slot").append(
      menu(
        button("New", undefined, {
          icon: "plus",
          variant: "solid",
          id: "new",
          className: "btn-new",
        }),
        () => [
          {
            label: "New note",
            icon: "file",
            action: act(() => this.create(false)),
          },
          ...(this.chordsEnabled
            ? [
                {
                  label: "New chord sequence",
                  icon: "chords" as const,
                  action: act(() => this.create(false, true)),
                },
              ]
            : []),
          {
            label: "New folder",
            icon: "folder",
            action: act(() => this.create(true)),
          },
        ],
      ),
    );
    this.get(".locations").append(
      button(
        "My notes",
        act(() => this.openRoot()),
        {
          icon: "notes",
          id: "root-folder",
          className: "nav-item",
        },
      ),
    );
    this.get("#menu-slot").append(
      button(
        "Toggle sidebar",
        () => this.root.classList.toggle("sidebar-open"),
        {
          icon: "menu",
          iconOnly: true,
          className: "menu-toggle",
        },
      ),
    );
    this.get(".scrim").addEventListener("click", () =>
      this.root.classList.remove("sidebar-open"),
    );
    this.get("#top-actions").append(
      button(
        "Sync now",
        act(() => this.sync()),
        {
          icon: "refresh",
          variant: "outline",
          id: "sync",
        },
      ),
      button(
        "Conflicts",
        act(() => this.conflicts()),
        { icon: "alert", variant: "outline", id: "conflicts" },
      ),
      button("Settings", () => this.settings(), {
        icon: "sliders",
        iconOnly: true,
        id: "settings",
      }),
    );
    this.get("#item-actions").append(
      button(
        "Rename / move",
        act(() => this.move()),
        { icon: "pencil", id: "move" },
      ),
      button(
        "Delete",
        act(() => this.delete()),
        { icon: "trash", id: "delete" },
      ),
    );
    for (const [label, glyph, before, after] of formatting) {
      const b =
        glyph.length === 1
          ? button(label, undefined, { iconOnly: true, className: "glyph" })
          : button(label, undefined, {
              icon: glyph as IconName,
              iconOnly: true,
            });
      if (glyph.length === 1)
        b.append(element("span", glyph, `glyph-${glyph}`));
      b.addEventListener("click", () => {
        if (this.current && !this.busy) format(this.editor, before, after);
      });
      this.get("#formatting").append(b);
    }
    const image = button(
      "Insert image",
      () => {
        if (this.current && !this.busy) picker.click();
      },
      { icon: "image", iconOnly: true, id: "insert-image" },
    );
    this.get("#formatting").append(image, picker);
    const empty = this.get("#empty");
    empty.append(
      element("div", undefined, "empty-art"),
      element("h2", "Choose or create a note"),
      element("p", undefined, "empty-hint"),
    );
    const emptyActions = element("div", undefined, "empty-actions");
    emptyActions.append(
      button(
        "Create a note",
        act(() => this.create(false)),
        {
          icon: "plus",
          variant: "solid",
        },
      ),
      button(
        "Create a chord sequence",
        act(() => this.create(false, true)),
        {
          icon: "chords",
          variant: "outline",
          id: "empty-new-chords",
        },
      ),
    );
    empty.append(emptyActions);
    empty.firstElementChild!.append(icon("file"));
    this.chordsEnabled =
      (await this.store.value<boolean>(CHORD_SETTING)) === true;
    this.applyChordSetting();
    this.theme = (await this.store.value<string>("theme")) ?? "system";
    const accent = (await this.store.value<string>("accent")) ?? "violet";
    this.accent = accent in palettes ? accent : "violet";
    document.documentElement.dataset.accent = this.accent;
    this.applyTheme();
    this.media.addEventListener("change", this.mediaListener);
    window.addEventListener("marknotes:error", this.errorListener);
    window.addEventListener("beforeunload", this.unloadListener);
    for (const provider of ["dropbox", "onedrive"] as const) {
      const name = providerNames[provider];
      const b = button(
        `Connect ${name}`,
        act(() => this.connect(provider)),
        {
          icon: "plus",
          className: "connect-item",
        },
      );
      if (!this.config[provider]) {
        b.disabled = true;
        b.setAttribute("aria-label", `${name}: not configured`);
        b.querySelector("span")!.textContent = name;
        b.append(element("small", "Not configured", "badge"));
      }
      this.get("#connect").append(b);
    }
    await this.refresh();
    const last = await this.store.value<string>("active-note");
    if (last) await exclusive(() => this.open(last));
    this.chrome();
    if ((await this.store.accounts()).length) await this.run(() => this.sync());
  }
  private applyTheme(): void {
    document.documentElement.dataset.theme =
      this.theme === "system"
        ? this.media.matches
          ? "dark"
          : "light"
        : this.theme;
  }
  private settings(): void {
    const { body, footer, close } = openDialog(
      "Settings",
      () => {},
      "modal-settings",
    );
    const persist = (key: string, value: string) =>
      void this.store
        .put(key, value)
        .catch((e: unknown) => this.error(message(e)));
    const section = (title: string, ...children: Node[]) => {
      const s = element("section", undefined, "setting");
      s.append(element("h3", title), ...children);
      return s;
    };
    const chordSwitch = toggle(
      "Create and edit chord sequences",
      this.chordsEnabled,
    );
    chordSwitch.id = "chord-sequences";
    chordSwitch.addEventListener("click", () => {
      const on = checked(chordSwitch);
      void (async () => {
        if (!on && !(await this.leaveChords())) {
          chordSwitch.setAttribute("aria-checked", "true");
          return;
        }
        await this.setChordsEnabled(on);
      })().catch((e: unknown) => this.error(message(e)));
    });
    const chordHint = element(
      "p",
      "Adds New chord sequence and opens chord notes in the chord editor. Stored only in this browser; notes are never changed.",
      "hint",
    );
    body.append(
      section(
        "Theme",
        segmented(
          "Theme",
          [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
          this.theme,
          (value) => {
            this.theme = value;
            this.applyTheme();
            persist("theme", value);
          },
        ),
      ),
      section(
        "Accent colour",
        segmented(
          "Accent",
          Object.entries(palettes).map(([value, swatch]) => ({
            value,
            label: capitalize(value),
            swatch,
          })),
          this.accent,
          (value) => {
            this.accent = value;
            document.documentElement.dataset.accent = value;
            persist("accent", value);
          },
          "swatches",
        ),
      ),
      section("Chord sequences", chordSwitch, chordHint),
      section(
        "Images",
        element(
          "p",
          "Remove image files that no note references any more. Deletions reach your drives at the next sync.",
          "hint",
        ),
        button(
          "Clean unused images",
          () => {
            close();
            void this.run(() => this.cleanImages());
          },
          { icon: "trash", variant: "outline", id: "clean-images" },
        ),
      ),
      section(
        "Privacy",
        element(
          "p",
          "Notes, paths and drive tokens never leave this browser except when syncing directly with your connected drives.",
          "hint",
        ),
      ),
    );
    footer.append(button("Done", close, { variant: "solid" }));
    body.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus();
  }
  private setEditable(value: boolean): void {
    if (this.editor) setEditorEditable(this.editor, value);
  }
  /** Shows the note body; front-matter stays hidden and is re-attached on save. */
  private showEditor(text: string, keepDraft = false): void {
    const body = noteBody(text);
    this.loading = true;
    this.editor.dispatch({
      changes: { from: 0, to: this.editor.state.doc.length, insert: body },
    });
    this.loading = false;
    this.renderPreview(body);
    this.applyMode(keepDraft);
  }
  private scheduleSave(): void {
    this.status("Unsaved changes");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.save().catch((e: unknown) => this.error(message(e)));
    }, 400);
  }
  /** Chooses the chord editor or the text editor for the open note (`type: chords` opens as chords). */
  private applyMode(keepDraft = false): void {
    const main = this.get("#main"),
      banner = this.get("#chord-banner"),
      toggle = this.get<HTMLButtonElement>("#view-mode");
    const chordFile =
      this.chordsEnabled &&
      !!this.current &&
      isChordSequence(this.current.text);
    main.classList.toggle("chord-file", chordFile);
    banner.hidden = true;
    let chords = false;
    if (chordFile && !this.textView) {
      const parsed = parseChordBody(this.editor.state.doc.toString());
      if (parsed.sequence) {
        this.chordEditor?.load(parsed.sequence, !keepDraft);
        chords = true;
      } else {
        banner.textContent = `This chord sequence could not be read (line ${parsed.error.line}: ${parsed.error.message}), so it is shown as text. Fix it, then choose View chords.`;
        banner.hidden = false;
      }
    }
    if (!chords) this.chordEditor?.discard();
    main.classList.toggle("chord-mode", chords);
    toggle.replaceChildren();
    toggle.append(
      icon(chords ? "code" : "chords"),
      element("span", chords ? "View as text" : "View chords"),
    );
  }
  /** Shows chord-sequence creation entry points only when the setting is on. */
  private applyChordSetting(): void {
    this.get("#empty-new-chords").hidden = !this.chordsEnabled;
    this.get(".empty-hint").textContent = this.chordsEnabled
      ? "Pick a note from the sidebar, or start a new note or chord sequence in this folder."
      : "Pick a note from the sidebar, or start a new note in this folder.";
  }
  private async setChordsEnabled(on: boolean): Promise<void> {
    this.chordsEnabled = on;
    await this.store.put(CHORD_SETTING, on);
    this.applyChordSetting();
    this.applyMode();
  }
  /** With the setting off, asks to turn it on before opening a chord sequence; true to open. */
  private async allowChords(note: Note | undefined): Promise<boolean> {
    if (!note || !needsChordOptIn(this.chordsEnabled, note)) return true;
    const ok = await confirmDialog({
      title: "Enable chord sequences?",
      text: `${note.path.split("/").at(-1)} is a chord sequence. Turn on chord sequences to open it in the chord editor? You can change this later in Settings.`,
      confirm: "Yes",
      cancel: "No",
    });
    if (!ok) return false;
    this.chordsEnabled = true;
    await this.store.put(CHORD_SETTING, true);
    this.applyChordSetting();
    return true;
  }
  private async toggleView(): Promise<void> {
    if (!this.current || this.busy) return;
    const chords = this.get("#main").classList.contains("chord-mode");
    if (chords && !(await this.leaveChords())) return;
    this.textView = chords;
    this.applyMode();
  }
  /** Mirrors chord-editor changes into the note text and autosaves it. */
  private chordsChanged(sequence: ChordSequence): void {
    if (!this.current) return;
    const body = serializeChordBody(
      sequence,
      chordLineEnding(this.current.text),
    );
    this.loading = true;
    this.editor.dispatch({
      changes: { from: 0, to: this.editor.state.doc.length, insert: body },
    });
    this.loading = false;
    this.dirty = true;
    this.renderPreview(body);
    this.scheduleSave();
  }
  /** Asks before discarding an unsaved chord draft; true when it is fine to leave. */
  private async leaveChords(): Promise<boolean> {
    if (!this.chordEditor?.dirty) return true;
    const ok = await confirmDialog({
      title: "Discard unsaved chord?",
      text: "The chord you are editing has not been added to the sequence yet.",
      confirm: "Discard",
      danger: true,
    });
    if (ok) this.chordEditor.discard();
    return ok;
  }
  private renderPreview(body: string): void {
    const ids = new Set(this.refs.map((r) => r.id));
    const pane = this.get("#preview");
    pane.innerHTML = preview(body, { resolve: (id) => ids.has(id) });
    void this.hydrateImages(pane).catch((e: unknown) => this.error(message(e)));
  }
  private async hydrateImages(pane: HTMLElement): Promise<void> {
    for (const img of pane.querySelectorAll<HTMLImageElement>(
      "img[data-attachment]",
    )) {
      const path = img.dataset.attachment!;
      let url = this.urls.get(path);
      if (!url) {
        const file = await this.store.attachment(path);
        if (file) {
          url = URL.createObjectURL(
            new Blob([file.bytes], { type: mimeFor(path) }),
          );
          this.urls.set(path, url);
        }
      }
      if (url) img.src = url;
      else {
        img.classList.add("missing");
        img.title =
          "Image not available in this browser yet. Sync to download it.";
      }
    }
  }
  private async insertImages(
    files: File[],
    position: number | null,
  ): Promise<void> {
    if (!this.current || this.busy) return;
    try {
      const lines: string[] = [];
      for (const file of files) {
        const image = await processImage(file);
        await this.store.putAttachment(image.path, image.bytes);
        lines.push(imageMarkdown(file.name || "image", image.path));
      }
      if (lines.length && this.current)
        insert(this.editor, lines.join("\n"), position ?? undefined);
    } catch (error) {
      this.error(message(error));
    }
  }
  private async cleanImages(): Promise<void> {
    const ok = await confirmDialog({
      title: "Clean unused images?",
      text: "Images not referenced by any note in this browser will be deleted here and, at the next sync, from your drives. Sync first if other devices may have new notes.",
      confirm: "Clean",
      danger: true,
    });
    if (!ok) return;
    const used = referencedAttachments(
      (await this.store.list()).map((n) => n.text),
    );
    let removed = 0;
    for (const path of await this.store.attachmentPaths())
      if (!used.has(path)) {
        await this.store.deleteAttachment(path);
        const url = this.urls.get(path);
        if (url) URL.revokeObjectURL(url);
        this.urls.delete(path);
        removed++;
      }
    this.status(
      removed
        ? `Removed ${removed} unused image${removed === 1 ? "" : "s"}`
        : "No unused images",
    );
  }
  private updateMention(mention: Mention | null): void {
    if (!mention || mention.from !== this.dismissed) this.dismissed = undefined;
    if (!mention || !this.current || this.dismissed !== undefined) {
      this.closeMention();
      return;
    }
    if (!this.mention) this.idsReady ??= this.prepareIds();
    const matches = filterRefs(this.refs, mention.query);
    // Typing a space with nothing matching means the @ was not meant as a link.
    if (!matches.length && /\s/.test(mention.query)) {
      this.closeMention();
      return;
    }
    if (this.mention?.query !== mention.query) this.active = 0;
    this.mention = mention;
    this.matches = matches;
    this.renderMentions();
  }
  /** Assigns ids to every note when the popup opens so all notes can be listed and linked. */
  private async prepareIds(): Promise<void> {
    try {
      await this.save();
      const changed = await exclusive(() => this.store.assignIds());
      if (changed.length) {
        const current = this.current;
        if (current && changed.includes(current.path))
          this.current = (await this.store.note(current.path)) ?? current;
        await this.refresh();
        this.chrome();
      }
      if (this.mention) this.updateMention(this.mention);
    } catch (error) {
      this.error(message(error));
    } finally {
      this.idsReady = undefined;
    }
  }
  private closeMention(): void {
    this.mention = null;
    this.matches = [];
    this.get("#mentions").hidden = true;
  }
  private renderMentions(): void {
    const panel = this.get("#mentions");
    panel.replaceChildren();
    if (!this.matches.length)
      panel.append(element("p", "No matching notes", "hint mention-empty"));
    this.matches.slice(0, 50).forEach((ref, index) => {
      const option = element("div", undefined, "mention");
      option.id = `mention-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === this.active));
      const text = element("div", undefined, "mention-text");
      text.append(
        element("strong", ref.title),
        element("small", ref.label, "mention-path"),
      );
      const chip = element("span", undefined, "id-chip");
      chip.append(
        element("code", ref.id),
        button(
          `Copy id ${ref.id}`,
          () => {
            void navigator.clipboard
              .writeText(ref.id)
              .then(() => this.status(`Copied note id ${ref.id}`))
              .catch((e: unknown) => this.error(message(e)));
          },
          { icon: "copy", iconOnly: true, className: "copy-id" },
        ),
      );
      option.append(icon("file"), text, chip);
      // Keep focus in the editor so typing continues to filter the list.
      option.addEventListener("mousedown", (e) => e.preventDefault());
      option.addEventListener("click", (e) => {
        if (!(e.target as Element).closest(".copy-id")) this.chooseMention(ref);
      });
      panel.append(option);
    });
    panel.hidden = false;
    panel
      .querySelector(`#mention-${this.active}`)
      ?.scrollIntoView({ block: "nearest" });
  }
  private mentionKey(key: "up" | "down" | "enter" | "escape"): boolean {
    if (!this.mention) return false;
    if (key === "escape") {
      this.dismissed = this.mention.from;
      this.closeMention();
      return true;
    }
    const count = Math.min(this.matches.length, 50);
    if (!count) return false;
    if (key === "enter") this.chooseMention(this.matches[this.active]);
    else {
      this.active = (this.active + (key === "down" ? 1 : count - 1)) % count;
      this.renderMentions();
    }
    return true;
  }
  private chooseMention(ref: NoteRef): void {
    const mention = this.mention;
    if (!mention) return;
    this.closeMention();
    insert(this.editor, noteLink(ref), mention.from, mention.to);
  }
  /** Updates the breadcrumb, selection and empty state to match the selection. */
  private chrome(): void {
    const title = this.get("#title");
    title.replaceChildren(element("span", "My notes"));
    for (const part of this.selected ? this.selected.split("/") : []) {
      title.append(icon("chevron"), element("span", part));
    }
    this.get("#main").classList.toggle("has-note", !!this.current);
    for (const id of ["#move", "#delete"])
      this.get<HTMLButtonElement>(id).disabled = !this.selected;
    for (const row of this.root.querySelectorAll<HTMLElement>(
      "#tree [data-path]",
    ))
      if (row.dataset.path === this.selected)
        row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    const root = this.get("#root-folder");
    if (this.selected) root.removeAttribute("aria-current");
    else root.setAttribute("aria-current", "true");
  }
  private status(text: string): void {
    this.get("#status").textContent = text;
  }
  private error(text: string): void {
    const e = this.get("#error");
    e.replaceChildren(
      icon("alert"),
      element("p", text),
      button("Dismiss", () => (e.hidden = true), {
        icon: "close",
        iconOnly: true,
      }),
    );
    e.hidden = false;
  }
  async save(): Promise<void> {
    if (this.saving) await this.saving;
    this.saving = this.savePending();
    try {
      await this.saving;
    } finally {
      this.saving = undefined;
    }
  }
  private async savePending(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.dirty || !this.current) return;
    const note = this.current,
      body = this.editor.state.doc.toString();
    await exclusive(async () => {
      const saved = await this.store.write(
        note.path,
        withBody(note.text, body),
        note.revision,
      );
      if (this.current?.path === note.path) {
        this.current = saved;
        if (this.editor.state.doc.toString() === body) this.dirty = false;
      }
    });
    this.status(this.dirty ? "Unsaved changes" : "Saved in this browser");
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.get<HTMLFieldSetElement>("#workspace").disabled = true;
    this.setEditable(false);
    this.get("#error").hidden = true;
    try {
      await this.save();
      await exclusive(action);
    } catch (error) {
      this.error(message(error));
    } finally {
      this.busy = false;
      this.get<HTMLFieldSetElement>("#workspace").disabled = false;
      this.setEditable(!!this.current);
      this.chrome();
    }
  }
  private async openRoot(): Promise<void> {
    if (!(await this.leaveChords())) return;
    this.selected = "";
    this.current = undefined;
    this.showEditor("");
    this.setEditable(false);
    await this.store.put("active-note", "");
    this.chrome();
  }
  private async open(path: string, confirmChords = true): Promise<void> {
    const same = path === this.current?.path;
    if (!same && !(await this.leaveChords())) return;
    if ((await this.store.assignIds([path])).length) await this.refresh();
    const note = await this.store.note(path);
    if (!same && confirmChords && !(await this.allowChords(note))) return;
    this.selected = note ? path : "";
    this.current = note?.folder ? undefined : note;
    this.dirty = false;
    if (!same) this.textView = false;
    this.showEditor(this.current?.text ?? "", same);
    this.setEditable(!!this.current && !this.busy);
    await this.store.put("active-note", this.current?.path ?? "");
    this.root.classList.remove("sidebar-open");
    this.chrome();
  }
  private targetFolder(): string {
    return this.current ? parent(this.selected) : this.selected;
  }
  private async create(folder: boolean, chords = false): Promise<void> {
    if (!(await this.leaveChords())) return;
    const where = this.targetFolder();
    const name = await ask({
      title: folder ? "New folder" : chords ? "New chord sequence" : "New note",
      label: folder ? "Folder name" : chords ? "Sequence name" : "Note name",
      value: folder ? "" : chords ? "Chords.md" : "Untitled.md",
      confirm: "Create",
      hint: `In /${where}`,
      validate: (value) =>
        validateName(!folder && !isNote(value) ? `${value}.md` : value),
    });
    if (name === null) return;
    const filename = !folder && !isNote(name) ? `${name}.md` : name;
    const path = join(where, filename);
    await this.store.create(
      path,
      folder,
      chords ? newChordSequenceText() : undefined,
    );
    await this.refresh();
    await this.open(path);
  }
  private async move(): Promise<void> {
    if (!this.selected) throw new Error("Select a note or folder first.");
    if (!(await this.leaveChords())) return;
    const to = await ask({
      title: "Rename or move",
      label: "New path",
      value: this.selected,
      confirm: "Save",
      hint: "Relative to the root folder. Include .md for notes.",
    });
    if (to === null || to === this.selected) return;
    await this.store.move(this.selected, to);
    await this.refresh();
    await this.open(to, false);
  }
  private async delete(): Promise<void> {
    if (!this.selected) throw new Error("Select a note or folder first.");
    const ok = await confirmDialog({
      title: `Delete ${this.selected.split("/").at(-1)}?`,
      text: `${this.selected} and its contents will be deleted. This will propagate to connected drives at the next sync.`,
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return;
    this.chordEditor?.discard();
    await this.store.delete(this.selected);
    await this.openRoot();
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    await this.updateConflicts();
    const tree = this.get("#tree");
    tree.replaceChildren();
    const notes = (await this.store.list()).filter(
      (n) => !inAttachments(n.path),
    );
    this.refs = noteRefs(notes.filter((n) => !n.folder));
    for (const note of notes) {
      const parts = note.path.split("/");
      if (
        parts
          .slice(0, -1)
          .some((_, i) => this.collapsed.has(parts.slice(0, i + 1).join("/")))
      )
        continue;
      const row = element("div", undefined, "tree-row");
      row.style.setProperty("--depth", String(parts.length - 1));
      const name = parts.at(-1)!;
      if (note.folder) {
        const open = !this.collapsed.has(note.path);
        const expander = button(
          `${open ? "Collapse" : "Expand"} ${name}`,
          () => {
            if (open) this.collapsed.add(note.path);
            else this.collapsed.delete(note.path);
            void this.refresh().then(() => this.chrome());
          },
          { icon: "chevron", iconOnly: true, className: "expander" },
        );
        expander.setAttribute("aria-expanded", String(open));
        expander.disabled = !notes.some((n) => parent(n.path) === note.path);
        row.append(expander);
      } else row.append(element("span", undefined, "expander-space"));
      const item = button(
        name,
        () => {
          void this.run(() => this.open(note.path));
        },
        {
          icon: note.folder
            ? "folder"
            : isChordSequence(note.text)
              ? "chords"
              : "file",
          className: "tree-item",
        },
      );
      item.dataset.path = note.path;
      item.title = note.path;
      row.append(item);
      tree.append(row);
    }
    if (!notes.length)
      tree.append(
        element("p", "No notes yet. Use New to create one.", "hint tree-empty"),
      );
    await this.renderAccounts();
  }
  private async renderAccounts(): Promise<void> {
    const accounts = this.get("#accounts");
    accounts.replaceChildren();
    for (const account of await this.store.accounts()) {
      const row = element("div", undefined, "account"),
        text = element("div", undefined, "account-text"),
        health = this.health.get(account.id);
      const badge = element("span", undefined, `account-icon ${health ?? ""}`);
      badge.append(icon("cloud"));
      badge.title =
        health === "error"
          ? "Last sync failed"
          : health === "ok"
            ? "Synced"
            : "Not synced yet";
      text.append(
        element("strong", account.label),
        element(
          "small",
          `${providerNames[account.provider]} · /${account.folder}`,
        ),
      );
      row.append(
        badge,
        text,
        menu(
          button(`Options for ${account.label}`, undefined, {
            icon: "more",
            iconOnly: true,
          }),
          () => [
            {
              label: "Reconnect",
              icon: "refresh",
              action: () => void this.run(() => this.reconnect(account)),
            },
            {
              label: "Disconnect",
              icon: "plug",
              danger: true,
              action: () => void this.run(() => this.disconnect(account)),
            },
          ],
          "end",
        ),
      );
      accounts.append(row);
    }
  }
  private async reconnect(account: Account): Promise<void> {
    const fresh = await this.auth.connect(account.provider);
    if (fresh.subject !== account.subject) {
      await this.auth.forget(fresh);
      throw new Error("Select the same provider account when reconnecting.");
    }
    const { Vault } = await import("./storage");
    const vault = new Vault(this.store),
      tokens = await vault.load(fresh.id);
    if (!tokens)
      throw new Error(
        "Provider credentials were not saved. Reconnect this account.",
      );
    await vault.save(account.id, tokens);
    await this.store.forgetAccount(fresh.id);
    this.remotes.delete(account.id);
    this.status("Account reconnected");
  }
  private async disconnect(account: Account): Promise<void> {
    const ok = await confirmDialog({
      title: "Disconnect drive?",
      text: `${account.label} will stop syncing. Notes in this browser and on the drive are kept.`,
      confirm: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    await this.auth.forget(account);
    this.remotes.delete(account.id);
    this.health.delete(account.id);
    await this.refresh();
  }
  private async connect(provider: Account["provider"]): Promise<void> {
    const account = await this.auth.connect(provider);
    try {
      const folder = await this.chooseFolder(drive(this.auth, account));
      if (folder === null) {
        await this.auth.forget(account);
        return;
      }
      account.folder = folder;
      await this.store.saveAccount(account);
      await this.refresh();
      this.status("Drive connected. Use Sync now to reconcile notes.");
    } catch (error) {
      await this.auth.forget(account);
      throw error;
    }
  }
  private chooseFolder(remote: Drive): Promise<string | null> {
    return new Promise((resolve) => {
      const { body, footer, error, close } = openDialog(
        "Choose cloud folder",
        () => resolve(null),
        "modal-chooser",
      );
      const crumb = element("p", "/", "chooser-path"),
        list = element("div", undefined, "chooser-list");
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", "Folders");
      const child = toggle("Create or use a child folder", true),
        name = element("input", undefined, "input");
      name.value = "MarkNotes";
      name.setAttribute("aria-label", "Child folder name");
      child.addEventListener("click", () => (name.disabled = !checked(child)));
      const options = element("div", undefined, "chooser-options");
      options.append(child, name);
      let path = "";
      const browse = async (next: string) => {
        showError(error, "");
        list.setAttribute("aria-busy", "true");
        try {
          const folders = await remote.folders(next);
          path = next;
          crumb.textContent = `/${path}`;
          list.replaceChildren();
          if (path)
            list.append(
              button("Parent folder", () => void browse(parent(path)), {
                icon: "chevron",
                className: "chooser-item parent",
              }),
            );
          for (const folder of folders.filter((f) => !f.name.startsWith(".")))
            list.append(
              button(folder.name, () => void browse(folder.path), {
                icon: "folder",
                className: "chooser-item",
              }),
            );
          if (!list.childElementCount)
            list.append(element("p", "No folders here.", "hint"));
        } catch (e) {
          showError(error, message(e));
        } finally {
          list.removeAttribute("aria-busy");
        }
      };
      body.append(crumb, list, options);
      footer.append(
        button(
          "Cancel",
          () => {
            close();
            resolve(null);
          },
          { variant: "outline" },
        ),
        button(
          "Use this folder",
          () => {
            try {
              if (checked(child)) validateName(name.value);
              close();
              resolve(checked(child) ? join(path, name.value) : path);
            } catch (e) {
              showError(error, message(e));
            }
          },
          { variant: "solid" },
        ),
      );
      void browse("");
    });
  }
  private remote(account: Account): Drive {
    let remote = this.remotes.get(account.id);
    if (!remote) {
      remote = drive(this.auth, account);
      this.remotes.set(account.id, remote);
    }
    return remote;
  }
  private async sync(): Promise<void> {
    const accounts = await this.store.accounts();
    if (!accounts.length) {
      this.status("Connect a drive to sync");
      return;
    }
    this.status("Syncing...");
    this.root.classList.add("syncing");
    try {
      const results = await syncAll(
        this.store,
        accounts.map((account) => ({ account, remote: this.remote(account) })),
      );
      for (const [id, r] of results)
        this.health.set(id, r.errors.length ? "error" : "ok");
      const errors = [...results.entries()].flatMap(([id, r]) =>
        r.errors.map(
          (e) => `${accounts.find((a) => a.id === id)?.label}: ${e}`,
        ),
      );
      const conflicts = [...results.values()].flatMap((r) => r.conflicts);
      const copies = [...new Set(conflicts.map((c) => c.copyPath))];
      await addConflicts(this.store, conflicts);
      await this.refresh();
      if (this.current) await this.open(this.current.path);
      this.status(
        `Sync finished${copies.length ? `: newest versions kept, older ones saved as ${copies.join(", ")} (see Conflicts)` : ""}${errors.length ? ` with ${errors.length} error(s)` : ""}`,
      );
      if (errors.length) this.error(errors.join("\n"));
    } finally {
      this.root.classList.remove("syncing");
    }
  }
  /** Shows the Conflicts button, with the number of conflicted copies left to review, only while there are some. */
  private async updateConflicts(): Promise<void> {
    const count = (await pendingConflicts(this.store)).length,
      trigger = this.get<HTMLButtonElement>("#conflicts");
    trigger.hidden = !count;
    trigger.querySelector("span")!.textContent = `Conflicts (${count})`;
  }
  private async driveName(id: string): Promise<string> {
    const account = (await this.store.accounts()).find((a) => a.id === id);
    return account
      ? `${providerNames[account.provider]} (${account.label})`
      : "a drive";
  }
  /** Lists the conflicted copies with their merge-back view. */
  private async conflicts(): Promise<void> {
    await new Promise<void>((resolve) => {
      const { body, footer, close } = openDialog(
        "Sync conflicts",
        resolve,
        "conflicts",
      );
      // Runs inside run(), which already holds the tree lock.
      const done = async (work: () => Promise<void>) => {
        await work();
        await this.refresh();
        if (this.current) await this.open(this.current.path);
        await render();
      };
      const section = async (conflict: SyncConflict) => {
        const merge = await loadMerge(this.store, conflict);
        const item = element("section", undefined, "conflict");
        item.append(element("h3", conflict.path));
        if (merge)
          item.append(
            mergeView(conflict, await this.driveName(conflict.driveId), merge, {
              merge: (text) =>
                done(() => applyMerge(this.store, conflict, text)),
              discard: () => done(() => discardCopy(this.store, conflict)),
              keepBoth: () => done(() => keepBoth(this.store, conflict)),
            }),
          );
        return item;
      };
      const render = async () => {
        const pending = await pendingConflicts(this.store);
        if (!pending.length) {
          close();
          resolve();
          return;
        }
        const sections: HTMLElement[] = [];
        for (const conflict of pending) sections.push(await section(conflict));
        body.replaceChildren(...sections);
      };
      footer.append(
        button(
          "Close",
          () => {
            close();
            resolve();
          },
          { variant: "outline" },
        ),
      );
      void render();
    });
  }
  connection(connected: boolean): void {
    const label = this.root.querySelector("#connection");
    if (label)
      label.textContent = connected
        ? ""
        : "Server disconnected - reconnecting. Local data is retained.";
  }
  destroy(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.media.removeEventListener("change", this.mediaListener);
    window.removeEventListener("marknotes:error", this.errorListener);
    window.removeEventListener("beforeunload", this.unloadListener);
    this.editor?.destroy();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.store?.close();
  }
}
