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

const palettes = [
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "red",
  "pink",
  "purple",
];
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text: string, action: () => void): HTMLButtonElement {
  const b = element("button", text);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}
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
  private media = matchMedia("(prefers-color-scheme: dark)");
  private theme = "system";
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
      <header><h1>MarkNotes</h1><span>Notes stay in this browser</span><span id="connection" role="status"></span></header>
      <p id="status" role="status" aria-live="polite">Ready</p><p id="error" role="alert" hidden></p>
      <fieldset id="workspace"><legend class="sr-only">Notes workspace</legend>
        <nav class="actions" aria-label="Note actions"><button id="root-folder">Root folder</button>
        <button id="new-note">New note</button><button id="new-folder">New folder</button>
        <button id="move">Rename / move</button><button id="delete">Delete</button><button id="sync">Sync now</button></nav>
        <div class="workspace"><aside><h2>Folders and notes</h2><nav id="tree" aria-label="Folders and notes"></nav></aside>
        <section class="document"><h2 id="title">Choose or create a note</h2>
          <nav id="formatting" aria-label="Formatting"></nav>
          <div class="panes"><div id="editor"></div><article id="preview" aria-label="Markdown preview"></article></div>
        </section></div>
        <section class="settings"><h2>Appearance</h2><label for="theme">Theme</label><select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
        <label for="accent">Accent</label><select id="accent"></select></section>
        <section class="settings"><h2>Connected drives</h2><p>All connected drives mirror the same local notes. Choose the same cloud folder as Android or desktop.</p>
        <div id="connect"></div><p>Proton Drive - planned. This is a third-party application not officially supported by Proton.</p>
        <div id="accounts"></div></section>
      </fieldset><dialog id="dialog"></dialog>`;
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
    const actions: Record<string, () => Promise<void>> = {
      "#root-folder": async () => {
        this.selected = "";
        this.current = undefined;
        this.showEditor("");
        this.get("#title").textContent = "Root folder";
        this.setEditable(false);
      },
      "#new-note": () => this.create(false),
      "#new-folder": () => this.create(true),
      "#move": () => this.move(),
      "#delete": () => this.delete(),
      "#sync": () => this.sync(),
    };
    for (const [selector, action] of Object.entries(actions))
      this.get(selector).addEventListener("click", () => {
        void this.run(action);
      });
    for (const [label, before, after] of [
      ["Bold", "**", "**"],
      ["Italic", "*", "*"],
      ["Heading", "## ", ""],
      ["Link", "[", "](https://)"],
      ["Code", "`", "`"],
      ["Code block", "```\n", "\n```"],
      ["List", "- ", ""],
      ["Checklist", "- [ ] ", ""],
      ["Quote", "> ", ""],
    ])
      this.get("#formatting").append(
        button(label, () => {
          if (this.current && !this.busy) format(this.editor, before, after);
        }),
      );
    const theme = this.get<HTMLSelectElement>("#theme"),
      accent = this.get<HTMLSelectElement>("#accent");
    palettes.forEach((p) => {
      const o = element("option", p);
      o.value = p;
      accent.append(o);
    });
    this.theme = (await this.store.value<string>("theme")) ?? "system";
    theme.value = this.theme;
    accent.value = (await this.store.value<string>("accent")) ?? "blue";
    document.documentElement.dataset.accent = accent.value;
    this.applyTheme();
    theme.addEventListener("change", () => {
      this.theme = theme.value;
      this.applyTheme();
      void this.store
        .put("theme", theme.value)
        .catch((e: unknown) => this.error(message(e)));
    });
    accent.addEventListener("change", () => {
      document.documentElement.dataset.accent = accent.value;
      void this.store
        .put("accent", accent.value)
        .catch((e: unknown) => this.error(message(e)));
    });
    this.media.addEventListener("change", this.mediaListener);
    window.addEventListener("marknotes:error", this.errorListener);
    window.addEventListener("beforeunload", this.unloadListener);
    for (const provider of ["dropbox", "onedrive"] as const) {
      const name = provider === "dropbox" ? "Dropbox" : "OneDrive";
      const b = button(
        this.config[provider] ? `Connect ${name}` : `${name}: not configured`,
        () => {
          void this.run(() => this.connect(provider));
        },
      );
      b.disabled = !this.config[provider];
      this.get("#connect").append(b);
    }
    await this.refresh();
    const last = await this.store.value<string>("active-note");
    if (last) await this.open(last);
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
  private status(text: string): void {
    this.get("#status").textContent = text;
  }
  private error(text: string): void {
    const e = this.get("#error");
    e.hidden = false;
    e.textContent = text;
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
    }
  }
  private async open(path: string): Promise<void> {
    const note = await this.store.note(path);
    this.selected = note ? path : "";
    this.current = note?.folder ? undefined : note;
    this.dirty = false;
    this.get("#title").textContent = note ? path : "Choose or create a note";
    this.showEditor(this.current?.text ?? "");
    this.setEditable(!!this.current && !this.busy);
    await this.store.put("active-note", this.current?.path ?? "");
  }
  private targetFolder(): string {
    return this.current ? parent(this.selected) : this.selected;
  }
  private async create(folder: boolean): Promise<void> {
    const name = prompt(
      folder ? "Folder name" : "Note name",
      folder ? "" : "Untitled.md",
    );
    if (name === null) return;
    const filename = !folder && !isNote(name) ? `${name}.md` : name;
    validateName(filename);
    const path = join(this.targetFolder(), filename);
    await this.store.create(path, folder);
    await this.refresh();
    await this.open(path);
  }
  private async move(): Promise<void> {
    if (!this.selected) throw new Error("Select a note or folder first.");
    const to = prompt(
      "New path, relative to the root (include .md for notes)",
      this.selected,
    );
    if (to === null) return;
    await this.store.move(this.selected, to);
    await this.refresh();
    await this.open(to);
  }
  private async delete(): Promise<void> {
    if (!this.selected) throw new Error("Select a note or folder first.");
    if (
      !confirm(
        `Delete ${this.selected} and its contents? This will propagate to connected drives at the next sync.`,
      )
    )
      return;
    await this.store.delete(this.selected);
    this.selected = "";
    this.current = undefined;
    this.showEditor("");
    this.get("#title").textContent = "Choose or create a note";
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    const tree = this.get("#tree");
    tree.replaceChildren();
    for (const note of await this.store.list()) {
      const b = button(
        `${note.folder ? "[Folder] " : ""}${note.path.split("/").at(-1)}`,
        () => {
          void this.run(() => this.open(note.path));
        },
      );
      b.style.paddingLeft = `${0.7 + (note.path.split("/").length - 1) * 1.1}rem`;
      b.dataset.path = note.path;
      tree.append(b);
    }
    const accounts = this.get("#accounts");
    accounts.replaceChildren();

    for (const account of await this.store.accounts()) {
      const row = element("div");
      row.className = "account";
      row.append(
        element("strong", `${account.provider}: ${account.label}`),
        element("span", ` /${account.folder}`),
      );
      row.append(
        button("Reconnect", () => {
          void this.run(async () => {
            const fresh = await this.auth.connect(account.provider);
            if (fresh.subject !== account.subject) {
              await this.auth.forget(fresh);
              throw new Error(
                "Select the same provider account when reconnecting.",
              );
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
          });
        }),
      );
      row.append(
        button("Disconnect", () => {
          void this.run(async () => {
            if (!confirm("Disconnect this drive? Local notes will be kept."))
              return;
            await this.auth.forget(account);
            this.remotes.delete(account.id);
            await this.refresh();
          });
        }),
      );
      accounts.append(row);
    }
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
    const dialog = this.get<HTMLDialogElement>("#dialog");
    dialog.replaceChildren();
    const title = element("h2", "Choose cloud folder"),
      pathLabel = element("p"),
      list = element("div"),
      error = element("p");
    const label = element("label"),
      child = element("input");
    child.type = "checkbox";
    child.checked = true;
    const name = element("input");
    name.value = "MarkNotes";
    name.setAttribute("aria-label", "Child folder name");
    label.append(child, " Create/use a child folder ", name);
    let path = "";
    const browse = async (next: string) => {
      error.textContent = "";
      try {
        const folders = await remote.folders(next);
        path = next;
        pathLabel.textContent = `/${path}`;
        list.replaceChildren();
        if (path)
          list.append(
            button("Parent folder", () => {
              void browse(parent(path));
            }),
          );
        for (const folder of folders.filter((f) => !f.name.startsWith(".")))
          list.append(
            button(folder.name, () => {
              void browse(folder.path);
            }),
          );
      } catch (e) {
        error.textContent = message(e);
      }
    };
    return new Promise((resolve) => {
      const finish = (value: string | null) => {
        dialog.close();
        dialog.oncancel = null;
        resolve(value);
      };
      dialog.oncancel = (event) => {
        event.preventDefault();
        finish(null);
      };
      dialog.append(
        title,
        pathLabel,
        list,
        label,
        error,
        button("Use this folder", () => {
          try {
            if (child.checked) validateName(name.value);
            finish(child.checked ? join(path, name.value) : path);
          } catch (e) {
            error.textContent = message(e);
          }
        }),
        button("Cancel", () => finish(null)),
      );
      dialog.showModal();
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
    this.status("Syncing...");
    const accounts = await this.store.accounts();
    if (!accounts.length) {
      this.status("Connect a drive to sync");
      return;
    }
    const results = await syncAll(
      this.store,
      accounts.map((account) => ({ account, remote: this.remote(account) })),
    );
    const errors = [...results.entries()].flatMap(([id, r]) =>
      r.errors.map((e) => `${accounts.find((a) => a.id === id)?.label}: ${e}`),
    );
    const copies = [...results.values()].flatMap((r) => r.copies);
    await this.refresh();
    if (this.current) await this.open(this.current.path);
    this.status(
      `Sync finished${copies.length ? `: newest versions kept, older ones saved as ${copies.join(", ")}` : ""}${errors.length ? ` with ${errors.length} error(s)` : ""}`,
    );
    if (errors.length) this.error(errors.join("\n"));
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
