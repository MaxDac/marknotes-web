// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDrive } from "./fake-drive";
import { Auth } from "../js/auth";
import { Session } from "../js/security";
import type { Account } from "../js/storage";
import type { CloudFolder } from "../js/providers";
import { NotesUI } from "../js/ui";

const guide = vi.hoisted(() => ({ replay: vi.fn(), active: false }));
vi.mock("../js/onboarding", () => ({
  FirstAccessGuide: class {
    get active(): boolean {
      return guide.active;
    }
    start(): Promise<void> {
      return Promise.resolve();
    }
    replay(): void {
      guide.replay();
    }
    destroy(): void {}
  },
}));
const help = vi.hoisted(() => ({
  show: vi.fn<(replay: () => void, memoryOnly: boolean) => void>(),
}));
vi.mock("../js/help", () => ({ showHelp: help.show }));
const drives = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../js/providers", () => ({ drive: () => drives.current }));

class TestDrive extends FakeDrive {
  listed: string[] = [];
  async folders(path: string): Promise<CloudFolder[]> {
    this.listed.push(path);
    return path
      ? []
      : [
          { name: "Documents", path: "Documents" },
          { name: ".hidden", path: ".hidden" },
        ];
  }
}

type Callback = (lock: Lock | null) => unknown;
/** Minimal Web Locks: exclusive/shared modes, `ifAvailable`, queued waiters and `query`. */
class FakeLocks {
  held: { name: string; mode: LockMode }[] = [];
  private waiters: (() => void)[] = [];
  async request(
    name: string,
    a: LockOptions | Callback,
    b?: Callback,
  ): Promise<unknown> {
    const options = typeof a === "function" ? {} : a;
    const callback = (typeof a === "function" ? a : b)!;
    const mode = options.mode ?? "exclusive";
    const blocked = () =>
      this.held.some(
        (l) =>
          l.name === name && (mode === "exclusive" || l.mode === "exclusive"),
      );
    if (blocked()) {
      if (options.ifAvailable) return callback(null);
      while (blocked()) await new Promise<void>((r) => this.waiters.push(r));
    }
    const lock = { name, mode };
    this.held.push(lock);
    try {
      return await callback(lock as Lock);
    } finally {
      this.held.splice(this.held.indexOf(lock), 1);
      for (const wake of this.waiters.splice(0)) wake();
    }
  }
  async query(): Promise<LockManagerSnapshot> {
    return { held: this.held.map((l) => ({ ...l })), pending: [] };
  }
}

class FakeChannel {
  static posted = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {}
  postMessage(): void {
    FakeChannel.posted++;
  }
  close(): void {}
}

const prototypes: [object, string][] = [
  [HTMLDialogElement.prototype, "showModal"],
  [HTMLDialogElement.prototype, "close"],
  [Element.prototype, "scrollIntoView"],
  [Range.prototype, "getClientRects"],
  [Range.prototype, "getBoundingClientRect"],
];
const originals = prototypes.map(([proto, key]) =>
  Object.getOwnPropertyDescriptor(proto, key),
);

let root: HTMLElement;
let ui: NotesUI | undefined;
let locks: FakeLocks;
let fetchMock: ReturnType<typeof vi.fn>;
let dark: boolean;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  locks = new FakeLocks();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  dark = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: dark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  fetchMock = vi.fn(() => Promise.reject(new Error("Network disabled")));
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  // CodeMirror measures text in animation frames; jsdom has no layout.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  guide.active = false;
  guide.replay.mockClear();
  help.show.mockClear();
  drives.current = undefined;
  root = document.createElement("div");
  root.id = "marknotes";
  document.body.append(root);
});

afterEach(() => {
  ui?.destroy();
  ui = undefined;
  // Note data, paths and tokens never reach a server: the UI made no network request.
  expect(fetchMock).not.toHaveBeenCalled();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
  prototypes.forEach(([proto, key], i) => {
    const descriptor = originals[i];
    if (descriptor) Object.defineProperty(proto, key, descriptor);
    else Reflect.deleteProperty(proto, key);
  });
  Reflect.deleteProperty(navigator, "locks");
  Reflect.deleteProperty(navigator, "onLine");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const config = { dropbox: "", onedrive: "" };
async function mount(publicConfig = config): Promise<NotesUI> {
  ui = new NotesUI(root, publicConfig);
  await ui.start();
  return ui;
}
async function remount(publicConfig = config): Promise<NotesUI> {
  ui?.destroy();
  root.replaceChildren();
  return mount(publicConfig);
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
};
const workspace = () => $<HTMLFieldSetElement>("#workspace");
const status = () => $("#status").textContent;
const editor = () =>
  EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-editor")!)!;
const text = () => editor().state.doc.toString();
const label = (el: Element) =>
  (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
function buttonIn(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => label(b) === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
const treeItems = () =>
  [...root.querySelectorAll<HTMLButtonElement>("#tree .tree-item")].map(
    (b) => b.textContent,
  );
const treeItem = (name: string) => {
  const item = [
    ...root.querySelectorAll<HTMLButtonElement>("#tree .tree-item"),
  ].find((b) => b.textContent === name);
  if (!item) throw new Error(`Missing tree item ${name}`);
  return item;
};
async function dialog(title: string): Promise<HTMLDialogElement> {
  return vi.waitFor(() => {
    const found = [
      ...document.querySelectorAll<HTMLDialogElement>("dialog"),
    ].find((d) => d.querySelector("h2")?.textContent === title);
    if (!found?.open) throw new Error(`No open dialog ${title}`);
    return found;
  });
}
const dialogs = () => document.querySelectorAll("dialog").length;
async function idle(): Promise<void> {
  await vi.waitFor(() => {
    expect(workspace().disabled).toBe(false);
    expect(status()).not.toBe("Working...");
  });
}
function choose(trigger: HTMLButtonElement, item: string): void {
  trigger.click();
  const anchor = trigger.closest(".menu-anchor")!;
  buttonIn(anchor.querySelector("[role=menu]")!, item).click();
}
async function answer(
  title: string,
  value: string,
  confirm: string,
): Promise<HTMLDialogElement> {
  const d = await dialog(title);
  d.querySelector<HTMLInputElement>("input")!.value = value;
  buttonIn(d.querySelector("footer")!, confirm).click();
  return d;
}
async function createNote(name: string): Promise<void> {
  choose($<HTMLButtonElement>("#new"), "New note");
  await answer("New note", name, "Create");
  await vi.waitFor(() => expect(treeItems()).toContain(name));
  await idle();
}
async function createFolder(name: string): Promise<void> {
  choose($<HTMLButtonElement>("#new"), "New folder");
  await answer("New folder", name, "Create");
  await vi.waitFor(() => expect(treeItems()).toContain(name));
  await idle();
}
function type(value: string): void {
  editor().dispatch({
    changes: { from: 0, to: editor().state.doc.length, insert: value },
    selection: { anchor: value.length },
  });
}
async function settings(): Promise<HTMLDialogElement> {
  $<HTMLButtonElement>("#settings").click();
  return dialog("Settings");
}
async function prepare(
  setup: (session: Session) => Promise<void>,
): Promise<void> {
  const session = await Session.open("marknotes", 1000);
  try {
    await setup(session);
  } finally {
    session.close();
  }
}

describe("startup", () => {
  it("renders an enabled empty workspace with storage, provider and offline state", async () => {
    await mount();
    expect(workspace().disabled).toBe(false);
    expect(status()).toBe("Ready");
    expect($("#tree").textContent).toContain("No notes yet");
    expect($(".local").textContent).toContain(
      "Notes are stored only in this browser",
    );
    expect($<HTMLAnchorElement>(".local a").getAttribute("href")).toBe(
      "/security",
    );
    expect($("#title").textContent).toBe("My notes");
    expect($("#root-folder").getAttribute("aria-current")).toBe("true");
    expect($<HTMLButtonElement>("#move").disabled).toBe(true);
    expect($<HTMLButtonElement>("#delete").disabled).toBe(true);
    expect($("#conflicts").hidden).toBe(true);
    expect(editor().state.readOnly).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.accent).toBe("violet");
    const connect = [
      ...root.querySelectorAll<HTMLButtonElement>("#connect button"),
    ];
    expect(connect.map((b) => [b.disabled, label(b)])).toEqual([
      [true, "Dropbox: not configured"],
      [true, "OneDrive: not configured"],
    ]);
    expect($("#empty-new-chords").hidden).toBe(true);
    expect($(".empty-hint").textContent).not.toContain("chord");

    window.dispatchEvent(new Event("offline"));
    expect($("#connection").textContent).toContain("Offline");
    window.dispatchEvent(new Event("online"));
    expect($("#connection").textContent).toBe("");
    ui!.connection(false);
    expect($("#connection").textContent).toContain("local editing");
  });
  it("follows the system dark theme", async () => {
    dark = true;
    await mount();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("does not render anything when destroyed before the session opens", async () => {
    ui = new NotesUI(root, config);
    const started = ui.start();
    ui.destroy();
    await started;
    expect(root.querySelector("#workspace")).toBeNull();
    expect(locks.held).toEqual([]);
  });
  it("refuses to start next to a locked tab and keeps the session lock single", async () => {
    await prepare(async (session) => {
      await session.store();
      await session.switchTo("locked", "correct horse battery");
    });
    const other = new NotesUI(document.createElement("div"), config);
    const unlocking = other.start();
    await vi.waitFor(() => expect(locks.held).toHaveLength(1));
    ui = new NotesUI(root, config);
    await expect(ui.start()).rejects.toThrow("already open in another tab");
    ui = other;
    void unlocking;
  });
});

describe("notes", () => {
  it("creates, edits, saves and reopens a note", async () => {
    await mount();
    await createNote("First");
    expect($("#title").textContent).toBe("My notesFirst");
    expect($("#main").classList.contains("has-note")).toBe(true);
    expect(treeItem("First").getAttribute("aria-current")).toBe("true");
    expect(editor().state.readOnly).toBe(false);
    expect($<HTMLButtonElement>("#move").disabled).toBe(false);

    type("# Hello\n\nSome *text*");
    expect(status()).toBe("Unsaved changes");
    expect($("#preview h1")?.textContent).toBe("Hello");
    expect($("#preview em")?.textContent).toBe("text");
    await ui!.save();
    expect(status()).toBe("Saved in this browser");

    await remount();
    expect(text()).toBe("# Hello\n\nSome *text*");
    expect(treeItem("First").getAttribute("aria-current")).toBe("true");
    expect($("#preview h1")?.textContent).toBe("Hello");
  });
  it("autosaves typed text after a short delay", async () => {
    await mount();
    await createNote("Auto");
    type("autosaved");
    await vi.waitFor(() => expect(status()).toBe("Saved in this browser"), {
      timeout: 3000,
    });
    await remount();
    expect(text()).toBe("autosaved");
  });
  it("validates names and reports duplicate notes", async () => {
    await mount();
    choose($<HTMLButtonElement>("#new"), "New note");
    const d = await answer("New note", "a/b", "Create");
    const error = d.querySelector<HTMLElement>("[role=alert]")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).not.toBe("");
    buttonIn(d.querySelector("footer")!, "Cancel").click();
    await idle();
    expect(dialogs()).toBe(0);
    expect(treeItems()).toEqual([]);

    await createNote("Twice");
    choose($<HTMLButtonElement>("#new"), "New note");
    await answer("New note", "Twice", "Create");
    await idle();
    expect($("#error").hidden).toBe(false);
    expect($("#error").textContent).toContain("That name already exists.");
    expect(status()).toBe("Action not completed");
    buttonIn($("#error"), "Dismiss").click();
    expect($("#error").hidden).toBe(true);
  });
  it("creates notes inside folders and collapses folders", async () => {
    await mount();
    await createFolder("Projects");
    expect($("#title").textContent).toBe("My notesProjects");
    expect($("#main").classList.contains("has-note")).toBe(false);
    choose($<HTMLButtonElement>("#new"), "New note");
    const d = await dialog("New note");
    expect(d.textContent).toContain("In /Projects");
    await answer("New note", "Inner", "Create");
    await vi.waitFor(() => expect(treeItems()).toEqual(["Projects", "Inner"]));
    await idle();
    expect(treeItem("Inner").title).toBe("Projects/Inner");
    expect($("#title").textContent).toBe("My notesProjectsInner");

    buttonIn($("#tree"), "Collapse Projects").click();
    await vi.waitFor(() => expect(treeItems()).toEqual(["Projects"]));
    const expand = buttonIn($("#tree"), "Expand Projects");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expand.click();
    await vi.waitFor(() => expect(treeItems()).toEqual(["Projects", "Inner"]));

    $<HTMLButtonElement>("#root-folder").click();
    await idle();
    expect($("#title").textContent).toBe("My notes");
    expect($("#main").classList.contains("has-note")).toBe(false);
    expect(editor().state.readOnly).toBe(true);
  });
  it("renames, moves and deletes notes", async () => {
    await mount();
    await createNote("Draft");
    type("keep me");
    $<HTMLButtonElement>("#move").click();
    let d = await dialog("Rename or move");
    expect(d.querySelector("input")!.value).toBe("Draft");
    await answer("Rename or move", "Final", "Save");
    await vi.waitFor(() => expect(treeItems()).toEqual(["Final"]));
    await idle();
    expect(text()).toBe("keep me");

    await createFolder("Archive");
    $<HTMLButtonElement>("#move").click();
    await answer("Rename or move", "Box", "Save");
    await vi.waitFor(() => expect(treeItems()).toEqual(["Box", "Final"]));
    await idle();

    treeItem("Final").click();
    await idle();
    $<HTMLButtonElement>("#delete").click();
    d = await dialog("Delete Final?");
    buttonIn(d.querySelector("footer")!, "Cancel").click();
    await idle();
    expect(treeItems()).toEqual(["Box", "Final"]);

    $<HTMLButtonElement>("#delete").click();
    d = await dialog("Delete Final?");
    expect(d.textContent).toContain("Final.md and its contents");
    buttonIn(d.querySelector("footer")!, "Delete").click();
    await vi.waitFor(() => expect(treeItems()).toEqual(["Box"]));
    await idle();
    expect($("#main").classList.contains("has-note")).toBe(false);
    expect($("#title").textContent).toBe("My notes");
  });
  it("leaves the path unchanged when renaming to the same name", async () => {
    await mount();
    await createNote("Same");
    $<HTMLButtonElement>("#move").click();
    await answer("Rename or move", "Same", "Save");
    await idle();
    expect(treeItems()).toEqual(["Same"]);
    $<HTMLButtonElement>("#move").click();
    const d = await dialog("Rename or move");
    buttonIn(d.querySelector("footer")!, "Cancel").click();
    await idle();
    expect(treeItems()).toEqual(["Same"]);
  });
});

describe("editing tools", () => {
  it("switches between edit, split and preview views", async () => {
    await mount();
    await createNote("Views");
    expect($("#main").dataset.view).toBe("split");
    const radio = (value: string) =>
      $<HTMLButtonElement>(`#view-switch [data-value=${value}]`);
    radio("preview").click();
    expect($("#main").dataset.view).toBe("preview");
    radio("edit").click();
    expect($("#main").dataset.view).toBe("edit");
    expect(radio("edit").getAttribute("aria-checked")).toBe("true");
    await createNote("Other");
    expect($("#main").dataset.view).toBe("split");
  });
  it("applies formatting buttons to the selection", async () => {
    await mount();
    await createNote("Format");
    type("word");
    const formatting = $("#formatting");
    for (const [name, expected] of [
      ["Bold", "**word**"],
      ["Italic", "***word***"],
    ] as const) {
      editor().dispatch({
        selection: { anchor: 0, head: editor().state.doc.length },
      });
      buttonIn(formatting, name).click();
      expect(text()).toBe(expected);
    }
    type("line");
    buttonIn(formatting, "Heading").click();
    expect(text()).toBe("# line");
    buttonIn(formatting, "Numbered list").click();
    expect(text()).toBe("1. # line");
    type("");
    buttonIn(formatting, "Checklist").click();
    expect(text()).toBe("- [ ] ");
  });
  it("ignores formatting without an open note", async () => {
    await mount();
    buttonIn($("#formatting"), "Bold").click();
    expect(text()).toBe("");
  });
  it("follows note links in the preview and reports missing ones", async () => {
    await mount();
    await createNote("Target");
    await createNote("Source");
    type("[broken](marknotes:zzzzzzzz)");
    const broken = $<HTMLAnchorElement>("#preview a[data-note-id]");
    expect(broken.classList.contains("broken")).toBe(true);
    broken.click();
    expect($("#error").hidden).toBe(false);
    expect($("#error").textContent).toContain("Note not found");

    // Opening the mention popup assigns ids, then lists every note with its id.
    editor().focus();
    type("@Tar");
    await vi.waitFor(() =>
      expect(root.querySelectorAll("#mentions [role=option]")).toHaveLength(1),
    );
    const option = $("#mentions [role=option]");
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(option.textContent).toContain("Target");
    option.click();
    expect($("#mentions").hidden).toBe(true);
    expect(text()).toMatch(/^\[Target\]\(marknotes:[0-9a-z]{8}\)$/);
    // Let the id assignment started by the popup release the tree lock.
    await vi.waitFor(() =>
      expect(locks.held.map((l) => l.name)).not.toContain("marknotes:tree"),
    );
    await ui!.save();
    const link = $<HTMLAnchorElement>("#preview a[data-note-id]");
    expect(link.classList.contains("broken")).toBe(false);
    link.click();
    await vi.waitFor(() =>
      expect(treeItem("Target").getAttribute("aria-current")).toBe("true"),
    );
    await idle();
    expect($("#title").textContent).toBe("My notesTarget");
  });
  it("navigates and dismisses the mention popup with the keyboard", async () => {
    await mount();
    await createNote("Alpha");
    await createNote("Beta");
    await createNote("Writer");
    editor().focus();
    type("@");
    await vi.waitFor(() =>
      expect(
        root.querySelectorAll("#mentions [role=option]").length,
      ).toBeGreaterThanOrEqual(2),
    );
    const selected = () =>
      $("#mentions [aria-selected=true]").querySelector("strong")!.textContent;
    const first = selected();
    const key = (name: string) =>
      editor().contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true }),
      );
    key("ArrowDown");
    expect(selected()).not.toBe(first);
    key("ArrowUp");
    expect(selected()).toBe(first);
    key("Escape");
    expect($("#mentions").hidden).toBe(true);
    type("plain");
    type("@zzz qq");
    expect($("#mentions").hidden).toBe(true);
    type("@Beta");
    await vi.waitFor(() => expect($("#mentions").hidden).toBe(false));
    key("Enter");
    expect(text()).toMatch(/^\[Beta\]\(marknotes:[0-9a-z]{8}\)$/);
    type("@nomatch");
    await vi.waitFor(() =>
      expect($("#mentions").textContent).toContain("No matching notes"),
    );
  });
});

describe("menus and chrome", () => {
  it("opens the New menu with the keyboard and closes it with Escape", async () => {
    await mount();
    const trigger = $<HTMLButtonElement>("#new");
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    const popup = $("#new-slot [role=menu]");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect([...popup.querySelectorAll("[role=menuitem]")].map(label)).toEqual([
      "New note",
      "New folder",
      "Import document",
    ]);
    popup.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(root.querySelector("#new-slot [role=menu]")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("toggles the sidebar and opens help", async () => {
    await mount();
    buttonIn(root, "Toggle sidebar").click();
    expect(root.classList.contains("sidebar-open")).toBe(true);
    $(".scrim").click();
    expect(root.classList.contains("sidebar-open")).toBe(false);
    $<HTMLButtonElement>("#help").click();
    expect(help.show).toHaveBeenCalledWith(expect.any(Function), false);
    help.show.mock.calls[0]![0]();
    expect(guide.replay).toHaveBeenCalled();
  });
  it("shows storage errors and records diagnostics", async () => {
    await mount();
    window.dispatchEvent(
      new CustomEvent("marknotes:error", { detail: "Storage was changed" }),
    );
    expect($("#error").hidden).toBe(false);
    expect($("#error").textContent).toContain("Storage was changed");
    window.dispatchEvent(new Event("marknotes:pwa-error"));
    ui!.recordDiagnostic("uncaught-error");
    ui!.recordDiagnostic("uncaught-error");
    const d = await settings();
    buttonIn(d, "Report a problem").click();
    const report = await dialog("Review problem report");
    const excerpt = report.querySelector("pre")!.textContent;
    expect(excerpt).toContain("storage-changed");
    expect(excerpt).toContain("offline-update-failed");
    expect(excerpt.match(/uncaught-error/g)).toHaveLength(1);
    const open = [...report.querySelectorAll("a")].find(
      (a) => a.textContent === "Open GitHub draft",
    )!;
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(open.hasAttribute("href")).toBe(false);
    open.click();
    expect(report.querySelector("[role=alert]")!.textContent).toContain(
      "Consent is required",
    );
    const consent = report.querySelector<HTMLInputElement>(
      "input[type=checkbox]",
    )!;
    consent.click();
    expect(open.getAttribute("aria-disabled")).toBe("false");
    expect(open.href).toMatch(/^https:\/\/github\.com\//);
    open.addEventListener("click", (event) => event.preventDefault());
    open.click();
    expect(report.isConnected).toBe(false);
  });
});

describe("settings", () => {
  it("changes and persists theme, accent and chord sequences", async () => {
    await mount();
    let d = await settings();
    buttonIn(d, "Dark").click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    buttonIn(d, "Teal").click();
    expect(document.documentElement.dataset.accent).toBe("teal");
    const chords = d.querySelector<HTMLButtonElement>("#chord-sequences")!;
    expect(chords.getAttribute("aria-checked")).toBe("false");
    chords.click();
    await vi.waitFor(() => expect($("#empty-new-chords").hidden).toBe(false));
    expect($(".empty-hint").textContent).toContain("chord sequence");
    buttonIn(d, "Done").click();
    expect(d.isConnected).toBe(false);

    await remount();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.accent).toBe("teal");
    expect($("#empty-new-chords").hidden).toBe(false);
    $<HTMLButtonElement>("#new").click();
    expect(
      [...root.querySelectorAll("#new-slot [role=menuitem]")].map(label),
    ).toContain("New chord sequence");
    $<HTMLButtonElement>("#new").click();

    d = await settings();
    expect(
      d.querySelector("#chord-sequences")!.getAttribute("aria-checked"),
    ).toBe("true");
    d.querySelector<HTMLButtonElement>("#chord-sequences")!.click();
    await vi.waitFor(() => expect($("#empty-new-chords").hidden).toBe(true));
    buttonIn(d, "System").click();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  it("stores the sync-on-reconnect preference and notifies other tabs", async () => {
    await mount();
    const d = await settings();
    const toggle = d.querySelector<HTMLButtonElement>("#sync-on-reconnect")!;
    const before = FakeChannel.posted;
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(FakeChannel.posted).toBe(before + 1);
    await remount();
    const again = await settings();
    expect(
      again.querySelector("#sync-on-reconnect")!.getAttribute("aria-checked"),
    ).toBe("true");
  });
  it("lists platform links and plain-storage security actions", async () => {
    await mount();
    const d = await settings();
    const security = d.querySelector("#security-settings")!;
    expect(security.textContent).toContain("kept unencrypted");
    expect(
      [...security.querySelectorAll("button[id]")].map((b) => b.id),
    ).toEqual(["lock-setup", "memory-only", "forget-device"]);
    expect(d.textContent).toContain("MarkNotes on other platforms");
  });
  it("exports and clears local diagnostics", async () => {
    await mount();
    const created = vi.fn<(blob: Blob) => string>(() => "blob:logs");
    const revoked = vi.fn();
    const original = {
      createObjectURL: URL.createObjectURL,
      revokeObjectURL: URL.revokeObjectURL,
    };
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const d = await settings();
    try {
      buttonIn(d, "Export logs").click();
      await vi.waitFor(() =>
        expect(status()).toBe("Sanitized logs exported locally"),
      );
    } finally {
      Object.assign(URL, original);
    }
    const blob = created.mock.calls[0][0];
    expect(JSON.parse(await blob.text())).toBeTypeOf("object");
    expect(clicked).toHaveBeenCalled();
    expect(revoked).toHaveBeenCalledWith("blob:logs");
    buttonIn(d, "Clear logs").click();
    await vi.waitFor(() =>
      expect(status()).toBe(
        "Local diagnostic logs and export snapshot cleared",
      ),
    );
  });
  it("cleans unused images", async () => {
    await mount();
    let d = await settings();
    buttonIn(d, "Clean unused images").click();
    d = await dialog("Clean unused images?");
    buttonIn(d.querySelector("footer")!, "Clean").click();
    await vi.waitFor(() => expect(status()).toBe("No unused images"));
  });
});

describe("storage modes", () => {
  it("unlocks a locked browser and offers locked-mode settings", async () => {
    await prepare(async (session) => {
      const store = await session.store();
      await store.create("Secret.md", false, "hidden text");
      await store.put("active-note", "Secret.md");
      await session.switchTo("locked", "correct horse battery");
    });
    ui = new NotesUI(root, config);
    const started = ui.start();
    const form = await vi.waitFor(() => $<HTMLFormElement>(".unlock-card"));
    expect(root.textContent).toContain("MarkNotes is locked");
    const input = form.querySelector<HTMLInputElement>("input")!;
    input.value = "wrong passphrase!";
    form.requestSubmit();
    await vi.waitFor(() =>
      expect(form.querySelector<HTMLElement>("[role=alert]")!.hidden).toBe(
        false,
      ),
    );
    expect($<HTMLButtonElement>("#unlock").disabled).toBe(false);
    input.value = "correct horse battery";
    form.requestSubmit();
    await started;
    expect(input.value).toBe("");
    expect($(".local").textContent).toContain("encrypted in this browser");
    expect(text()).toBe("hidden text");

    const d = await settings();
    const security = d.querySelector("#security-settings")!;
    expect(security.textContent).toContain("after 15 minutes");
    expect(
      [...security.querySelectorAll("button[id]")].map((b) => b.id),
    ).toEqual([
      "lock-now",
      "change-passphrase",
      "remove-passphrase",
      "memory-only",
      "forget-device",
    ]);
    buttonIn(security, "Off").click();
    expect(security.textContent).toContain("stays unlocked");
  });
  it("removes the passphrase after verifying it", async () => {
    await prepare(async (session) => {
      await session.store();
      await session.switchTo("locked", "correct horse battery");
    });
    ui = new NotesUI(root, config);
    const started = ui.start();
    const form = await vi.waitFor(() => $<HTMLFormElement>(".unlock-card"));
    form.querySelector<HTMLInputElement>("input")!.value =
      "correct horse battery";
    form.requestSubmit();
    await started;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = await settings();
    buttonIn(d, "Remove passphrase").click();
    const remove = await dialog("Remove passphrase?");
    const field = remove.querySelector<HTMLInputElement>("input")!;
    field.value = "not the passphrase";
    buttonIn(remove.querySelector("footer")!, "Remove passphrase").click();
    await vi.waitFor(() =>
      expect(remove.querySelector<HTMLElement>(".field-error")!.hidden).toBe(
        false,
      ),
    );
    field.value = "correct horse battery";
    buttonIn(remove.querySelector("footer")!, "Remove passphrase").click();
    await vi.waitFor(() => expect(remove.isConnected).toBe(false));
    await vi.waitFor(() => expect(locks.held).toEqual([]));
    await remount();
    expect($(".local").textContent).toContain("stored only in this browser");
  });
  it("refuses updates in memory-only mode and switches back to browser storage", async () => {
    await prepare(async (session) => {
      await session.store();
      await session.switchTo("ephemeral");
    });
    await mount();
    expect($(".local").textContent).toContain("Memory only");
    await expect(ui!.prepareUpdate()).rejects.toThrow("Memory-only notes");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = await settings();
    expect(d.querySelector("#lock-setup")!.textContent).toBe(
      "Store encrypted with a passphrase",
    );
    buttonIn(d, "Store in this browser").click();
    const confirm = await dialog("Store in this browser?");
    buttonIn(confirm.querySelector("footer")!, "Store in this browser").click();
    await vi.waitFor(() => expect(locks.held).toEqual([]));
    await remount();
    expect($(".local").textContent).toContain("stored only in this browser");
  });
  it("forgets the device after confirmation", async () => {
    await mount();
    await createNote("Gone");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let d = await settings();
    buttonIn(d, "Forget this device").click();
    d = await dialog("Forget this device?");
    buttonIn(d.querySelector("footer")!, "Cancel").click();
    await idle();
    d = await settings();
    buttonIn(d, "Forget this device").click();
    d = await dialog("Forget this device?");
    buttonIn(d.querySelector("footer")!, "Forget this device").click();
    await vi.waitFor(() => expect(locks.held).toEqual([]));
    await remount();
    expect(treeItems()).toEqual([]);
  });
});

describe("updates", () => {
  it("pauses editing while an update is prepared and resumes afterwards", async () => {
    await mount();
    await createNote("Pending");
    type("unsaved");
    const resume = await ui!.prepareUpdate();
    expect(workspace().disabled).toBe(true);
    expect(editor().state.readOnly).toBe(true);
    expect(status()).toBe("Saved in this browser");
    resume();
    expect(workspace().disabled).toBe(false);
    expect(editor().state.readOnly).toBe(false);
  });
  it("refuses to update while another tab holds the session or before startup", async () => {
    ui = new NotesUI(root, config);
    await expect(ui.prepareUpdate()).rejects.toThrow();
    await ui.start();
    locks.held.push({ name: "marknotes:session", mode: "shared" });
    await expect(ui.prepareUpdate()).rejects.toThrow(
      "Close other MarkNotes tabs",
    );
    expect(workspace().disabled).toBe(false);
    locks.held.pop();
    guide.active = true;
    await expect(ui.prepareUpdate()).rejects.toThrow(
      "Finish or skip the guide",
    );
  });
});

describe("drives", () => {
  const account: Account = {
    id: "dropbox-test",
    provider: "dropbox",
    label: "me@example.com",
    folder: "",
    subject: "subject-1",
  };
  /** Keeps the real `forget` (which drops the stored account) but skips token revocation. */
  function spyForget() {
    vi.spyOn(
      Auth.prototype as unknown as { revokeDropbox(a: Account): Promise<void> },
      "revokeDropbox",
    ).mockResolvedValue();
    return vi.spyOn(Auth.prototype, "forget");
  }
  async function connectDropbox(remote: TestDrive): Promise<void> {
    drives.current = remote;
    vi.spyOn(Auth.prototype, "connect").mockResolvedValue({ ...account });
    buttonIn($("#connect"), "Connect Dropbox").click();
    const d = await dialog("Choose cloud folder");
    await vi.waitFor(() =>
      expect(
        [...d.querySelectorAll(".chooser-item")].map((b) => b.textContent),
      ).toEqual(["Documents"]),
    );
    buttonIn(d, "Documents").click();
    await vi.waitFor(() =>
      expect(d.querySelector(".chooser-path")!.textContent).toBe("/Documents"),
    );
    expect(buttonIn(d, "Parent folder")).toBeTruthy();
    buttonIn(d.querySelector("footer")!, "Use this folder").click();
    await vi.waitFor(() =>
      expect($("#accounts").textContent).toContain("me@example.com"),
    );
    await idle();
  }

  it("connects a drive, syncs notes to it and disconnects it", async () => {
    const remote = new TestDrive();
    const forget = spyForget();
    await mount({ dropbox: "app-key", onedrive: "" });
    expect(buttonIn($("#connect"), "Connect Dropbox").disabled).toBe(false);
    await createNote("Synced");
    type("to the drive");
    await connectDropbox(remote);
    expect($("#accounts").textContent).toContain(
      "Dropbox · /Documents/MarkNotes",
    );
    expect(status()).toBe("Drive connected. Use Sync now to reconcile notes.");

    $<HTMLButtonElement>("#sync").click();
    await vi.waitFor(() => expect(status()).toBe("Sync finished"));
    await idle();
    expect(remote.data.get("Synced.md")?.text).toContain("to the drive");
    expect($(".account-icon").classList.contains("ok")).toBe(true);
    expect($("#accounts").textContent).toContain("Last sync:");

    remote.data.set("Remote.md", {
      entry: {
        path: "Remote.md",
        id: "remote-1",
        folder: false,
        version: "r1",
        modifiedAt: Date.now(),
      },
      text: "from elsewhere",
    });
    $<HTMLButtonElement>("#sync").click();
    await vi.waitFor(() => expect(treeItems()).toContain("Remote"));
    await idle();

    remote.fail = true;
    $<HTMLButtonElement>("#sync").click();
    await vi.waitFor(() => expect(status()).toContain("with 1 error(s)"));
    await idle();
    expect($("#error").textContent).toContain("me@example.com: ");
    expect($(".account-icon").classList.contains("error")).toBe(true);

    choose(
      buttonIn($("#accounts"), "Options for me@example.com"),
      "Disconnect",
    );
    const d = await dialog("Disconnect drive?");
    expect(d.querySelector("#delete-local-notes")).not.toBeNull();
    buttonIn(d.querySelector("footer")!, "Disconnect").click();
    await vi.waitFor(() => expect($("#accounts").textContent).toBe(""));
    await idle();
    expect(forget).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
    );
    expect(treeItems()).toEqual(["Remote", "Synced"]);
    $<HTMLButtonElement>("#sync").click();
    await vi.waitFor(() => expect(status()).toBe("Connect a drive to sync"));
  });
  it("forgets the account when choosing a folder is cancelled", async () => {
    const forget = spyForget();
    drives.current = new TestDrive();
    vi.spyOn(Auth.prototype, "connect").mockResolvedValue({ ...account });
    await mount({ dropbox: "app-key", onedrive: "" });
    buttonIn($("#connect"), "Connect Dropbox").click();
    const d = await dialog("Choose cloud folder");
    buttonIn(d.querySelector("footer")!, "Cancel").click();
    await idle();
    expect(forget).toHaveBeenCalled();
    expect($("#accounts").textContent).toBe("");
  });
  it("syncs connected drives on startup and reports being offline", async () => {
    const remote = new TestDrive();
    drives.current = remote;
    await prepare(async (session) => {
      const store = await session.store();
      await store.saveAccount({ ...account, folder: "Notes" });
      await store.create("Local.md", false, "local");
    });
    await mount({ dropbox: "app-key", onedrive: "" });
    expect(status()).toBe("Sync finished");
    expect(remote.data.has("Local.md")).toBe(true);

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    $<HTMLButtonElement>("#sync").click();
    await vi.waitFor(() => expect(status()).toContain("Offline"));
  });
});
