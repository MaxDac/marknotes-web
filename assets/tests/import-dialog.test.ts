// @vitest-environment jsdom
import { Blob, File } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importDialog } from "../js/import-dialog";
import { MemoryBackend } from "../js/backend";
import { Store } from "../js/storage";
import { attachmentPath } from "../js/attachments";
import { noteBody } from "../js/notemeta";

const GIF = new Uint8Array(
  Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  ),
);
const file = (
  text: string | Uint8Array<ArrayBuffer>,
  name: string,
  type = "",
) => new File([text], name, { type }) as unknown as globalThis.File;

let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("fetch", vi.fn());
  URL.createObjectURL = vi.fn(() => {
    urls.push(`blob:test/${urls.length}`);
    return urls.at(-1)!;
  });
  URL.revokeObjectURL = vi.fn();
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
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  document.body.replaceChildren();
});

const $ = <T extends Element>(selector: string) =>
  document.querySelector<T>(selector)!;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  )!;
const create = () => buttonNamed("Import note");
const status = () => $("dialog [role=status]").textContent;
const alert = () => $<HTMLElement>("dialog [role=alert]");
const type = (selector: string, value: string, event = "input") => {
  const input = $<HTMLInputElement | HTMLTextAreaElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
};
const previewText = async (text: string) => {
  type("#import-source", text);
  buttonNamed("Preview text").click();
  await vi.waitFor(() => expect(create().disabled).toBe(false));
};

async function open(folder = "", files?: globalThis.File[]) {
  const store = new Store(new MemoryBackend());
  await store.create("Work", true);
  await store.create("Work/Deep", true);
  const result = importDialog(store, folder, files);
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")).not.toBeNull(),
  );
  return { store, result };
}

describe("import dialog", () => {
  it("previews pasted text, suggests a title and imports into the chosen folder", async () => {
    const { store, result } = await open("Work");
    expect(
      [...$<HTMLSelectElement>("#import-folder").options].map((o) => [
        o.value,
        o.text,
      ]),
    ).toEqual([
      ["", "My notes"],
      ["Work", "/Work"],
      ["Work/Deep", "/Work/Deep"],
    ]);
    expect($<HTMLSelectElement>("#import-folder").value).toBe("Work");
    expect($<HTMLInputElement>("#import-title").value).toBe("Imported note");
    expect(create().disabled).toBe(true);

    await previewText("Shopping list\n\n* eggs\n* milk");
    expect($("dialog .preview").querySelectorAll("li")).toHaveLength(2);
    expect($<HTMLInputElement>("#import-title").value).toBe("Shopping list");

    // Turning auto-format off re-renders the same document without conversion.
    const autoformat = $<HTMLButtonElement>("dialog [role=switch]");
    expect(autoformat.disabled).toBe(false);
    autoformat.click();
    expect(autoformat.getAttribute("aria-checked")).toBe("false");

    type("#import-folder", "Work/Deep", "change");
    create().click();
    const path = await result;
    expect(path).toBe("Work/Deep/Shopping list.md");
    expect(noteBody((await store.note(path!))!.text)).toContain("* eggs");
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("keeps an edited title and sanitises it", async () => {
    const { result } = await open();
    type("#import-title", "  a/b: c?  ");
    await previewText("# Heading\n\nBody");
    expect($<HTMLInputElement>("#import-title").value).toBe("  a/b: c?  ");
    create().click();
    expect(await result).toBe("a b c.md");
  });

  it("falls back to the default title when the edited title is empty", async () => {
    const { result } = await open();
    type("#import-title", "///");
    await previewText("text");
    create().click();
    expect(await result).toBe("Imported note.md");
  });

  it("invalidates the preview when the text or format changes", async () => {
    await open();
    await previewText("first");
    type("#import-source", "second");
    expect(create().disabled).toBe(true);
    expect($("dialog .preview").childElementCount).toBe(0);
    await previewText("second");
    type("#import-kind", "html", "change");
    expect(create().disabled).toBe(true);
  });

  it("shows conversion errors and keeps the dialog usable", async () => {
    await open();
    buttonNamed("Preview text").click();
    await vi.waitFor(() =>
      expect(alert().textContent).toBe("Paste or enter some text first."),
    );
    expect(alert().hidden).toBe(false);
    expect(status()).toBe("");
    expect($<HTMLTextAreaElement>("#import-source").disabled).toBe(false);
    await previewText("now it works");
    expect(alert().hidden).toBe(true);
  });

  it("converts pasted HTML, keeping the plain-text alternative", async () => {
    await open();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    const data: Record<string, string> = {
      "text/html": "<h2>Pasted</h2><p><em>rich</em> text</p>",
      "text/plain": "Pasted\nrich text",
    };
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (kind: string) => data[kind] ?? "" },
    });
    $("#import-source").dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect($<HTMLSelectElement>("#import-kind").value).toBe("html");
    buttonNamed("Preview text").click();
    await vi.waitFor(() => expect(create().disabled).toBe(false));
    expect($("dialog .preview h2")?.textContent).toBe("Pasted");
    expect($("dialog .preview em")?.textContent).toBe("rich");

    // A plain-text paste is left to the textarea.
    const plain = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(plain, "clipboardData", {
      value: { getData: () => "" },
    });
    $("#import-source").dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  it("imports files given on open, previewing referenced and missing images", async () => {
    const store = new Store(new MemoryBackend());
    const known = await attachmentPath(GIF, "image/gif");
    await store.putAttachment(known, GIF);
    const result = importDialog(store, "", [
      file(
        `# Trip\n\n![Known](${known})\n\n![Missing](attachments/${"0".repeat(64)}.png)`,
        "trip.md",
      ),
    ]);
    await vi.waitFor(() => expect(create().disabled).toBe(false));
    // Markdown is kept as is, so auto-format does not apply.
    expect($<HTMLButtonElement>("dialog [role=switch]").disabled).toBe(true);
    expect($<HTMLInputElement>("#import-title").value).toBe("Trip");
    await vi.waitFor(() => {
      const images = [...document.querySelectorAll("dialog .preview img")];
      expect(images.map((img) => img.getAttribute("src"))).toEqual([
        "blob:test/0",
        null,
      ]);
      expect(images[1]!.classList.contains("missing")).toBe(true);
    });
    buttonNamed("Cancel").click();
    expect(await result).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test/0");
  });

  it("imports picked and dropped images as a note with attachments", async () => {
    const { store, result } = await open();
    const picker = $<HTMLInputElement>("#import-file");
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [file("not supported", "note.exe")],
    });
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(alert().textContent).toContain("Choose a TXT, Markdown"),
    );

    const dialog = $("dialog");
    const dragover = new Event("dragover", { cancelable: true });
    Object.defineProperty(dragover, "dataTransfer", {
      value: { types: ["Files"] },
    });
    dialog.dispatchEvent(dragover);
    expect(dragover.defaultPrevented).toBe(true);
    const textDrag = new Event("dragover", { cancelable: true });
    Object.defineProperty(textDrag, "dataTransfer", {
      value: { types: ["text/plain"] },
    });
    dialog.dispatchEvent(textDrag);
    expect(textDrag.defaultPrevented).toBe(false);
    const empty = new Event("drop", { cancelable: true });
    Object.defineProperty(empty, "dataTransfer", { value: { files: [] } });
    dialog.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(false);

    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file(GIF, "photo.gif", "image/gif")] },
    });
    dialog.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(create().disabled).toBe(false));
    expect(document.querySelector("dialog .preview img")).not.toBeNull();
    create().click();
    const path = await result;
    const text = (await store.note(path!))!.text;
    const image = /\((attachments\/[0-9a-f]{64}\.gif)\)/.exec(text)![1]!;
    expect([...(await store.attachment(image))!.bytes]).toEqual([...GIF]);
  });

  it("refuses a second conversion while one is running", async () => {
    await open();
    type("#import-source", "one");
    buttonNamed("Preview text").click();
    // Controls are disabled meanwhile, but a late file-picker change still arrives.
    const picker = $<HTMLInputElement>("#import-file");
    expect(picker.disabled).toBe(true);
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [file("two", "two.txt")],
    });
    picker.dispatchEvent(new Event("change"));
    expect(alert().textContent).toBe(
      "Wait for the current conversion to finish.",
    );
    expect(status()).toBe("Converting in this browser…");
    await vi.waitFor(() => expect(create().disabled).toBe(false));
  });

  it("locks the dialog while saving and restores it when saving fails", async () => {
    const { store, result } = await open();
    let fail!: (error: Error) => void;
    const importNote = vi
      .spyOn(store, "importNote")
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => (fail = reject)),
      );
    await previewText("text");
    create().click();
    expect(create().disabled).toBe(true);
    expect($<HTMLTextAreaElement>("#import-source").disabled).toBe(true);
    // Escape cannot close the dialog mid-save, and Import is ignored.
    const cancel = new Event("cancel", { cancelable: true });
    $("dialog").dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(document.querySelector("dialog")).not.toBeNull();
    create().click();
    expect(importNote).toHaveBeenCalledOnce();

    fail(new Error("Storage is full."));
    await vi.waitFor(() =>
      expect(alert().textContent).toBe("Storage is full."),
    );
    expect(create().disabled).toBe(false);
    expect($<HTMLTextAreaElement>("#import-source").disabled).toBe(false);
    // Escape cancels again once nothing is being saved.
    $("dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(await result).toBeNull();
  });

  it("ignores a conversion that finishes after the dialog closed", async () => {
    const { result } = await open("", undefined);
    type("#import-source", "late");
    buttonNamed("Preview text").click();
    buttonNamed("Close").click();
    expect(await result).toBeNull();
    await Promise.resolve();
    expect(document.querySelector("dialog")).toBeNull();
  });
});
