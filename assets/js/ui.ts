import { type EditorView } from "@codemirror/view";
import { Auth, type PublicConfig } from "./auth";
import { createEditor, format, preview, setEditorEditable } from "./editor";
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
  private errorListener = (e: Event) =>
    this.error(String((e as CustomEvent<unknown>).detail));
  private unloadListener = (event: BeforeUnloadEvent) => {
    if (this.dirty) {
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
            <div id="item-actions" class="item-actions"></div>
          </div>
          <section id="empty" class="empty"></section>
          <div class="panes">
            <div class="pane"><div id="editor"></div></div>
            <article id="preview" class="pane preview" aria-label="Markdown preview"></article>
          </div>
        </div>
      </fieldset>
      <div id="error" class="toast" role="alert" hidden></div>`;
    this.get(".brand").prepend(logo());
    this.get(".local").append(
      icon("lock"),
      element("span", "Notes are stored only in this browser"),
    );
    this.editor = createEditor(this.get("#editor"), (text) => {
      if (this.loading || !this.current) return;
      this.dirty = true;
      this.get("#preview").innerHTML = preview(text);
      this.status("Unsaved changes");
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.save().catch((e: unknown) => this.error(message(e)));
      }, 400);
    });
    this.setEditable(false);
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
    const empty = this.get("#empty");
    empty.append(
      element("div", undefined, "empty-art"),
      element("h2", "Choose or create a note"),
      element(
        "p",
        "Pick a note from the sidebar, or start a new one in this folder.",
      ),
      button(
        "Create a note",
        act(() => this.create(false)),
        {
          icon: "plus",
          variant: "solid",
        },
      ),
    );
    empty.firstElementChild!.append(icon("file"));
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
    if (last) await this.open(last);
    else this.chrome();
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
  private showEditor(text: string): void {
    this.loading = true;
    this.editor.dispatch({
      changes: { from: 0, to: this.editor.state.doc.length, insert: text },
    });
    this.loading = false;
    this.get("#preview").innerHTML = preview(text);
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
      text = this.editor.state.doc.toString();
    await exclusive(async () => {
      const saved = await this.store.write(note.path, text, note.revision);
      if (this.current?.path === note.path) {
        this.current = saved;
        if (this.editor.state.doc.toString() === text) this.dirty = false;
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
    this.selected = "";
    this.current = undefined;
    this.showEditor("");
    this.setEditable(false);
    await this.store.put("active-note", "");
    this.chrome();
  }
  private async open(path: string): Promise<void> {
    const note = await this.store.note(path);
    this.selected = note ? path : "";
    this.current = note?.folder ? undefined : note;
    this.dirty = false;
    this.showEditor(this.current?.text ?? "");
    this.setEditable(!!this.current && !this.busy);
    await this.store.put("active-note", this.current?.path ?? "");
    this.root.classList.remove("sidebar-open");
    this.chrome();
  }
  private targetFolder(): string {
    return this.current ? parent(this.selected) : this.selected;
  }
  private async create(folder: boolean): Promise<void> {
    const where = this.targetFolder();
    const name = await ask({
      title: folder ? "New folder" : "New note",
      label: folder ? "Folder name" : "Note name",
      value: folder ? "" : "Untitled.md",
      confirm: "Create",
      hint: `In /${where}`,
      validate: (value) =>
        validateName(!folder && !isNote(value) ? `${value}.md` : value),
    });
    if (name === null) return;
    const filename = !folder && !isNote(name) ? `${name}.md` : name;
    const path = join(where, filename);
    await this.store.create(path, folder);
    await this.refresh();
    await this.open(path);
  }
  private async move(): Promise<void> {
    if (!this.selected) throw new Error("Select a note or folder first.");
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
    await this.open(to);
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
    await this.store.delete(this.selected);
    await this.openRoot();
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    const tree = this.get("#tree");
    tree.replaceChildren();
    const notes = await this.store.list();
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
        { icon: note.folder ? "folder" : "file", className: "tree-item" },
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
      const copies = [...results.values()].flatMap((r) => r.copies);
      await this.refresh();
      if (this.current) await this.open(this.current.path);
      this.status(
        `Sync finished${copies.length ? `: newest versions kept, older ones saved as ${copies.join(", ")}` : ""}${errors.length ? ` with ${errors.length} error(s)` : ""}`,
      );
      if (errors.length) this.error(errors.join("\n"));
    } finally {
      this.root.classList.remove("syncing");
    }
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
    this.store?.close();
  }
}
