import {
  canFormat,
  importBody,
  IMPORT_ACCEPT,
  importFiles,
  importHtml,
  importText,
  type ImportedDocument,
} from "./document-import";
import { DEFAULT_TITLE, sanitizeTitle, suggestTitle } from "./import-format";
import {
  button,
  checked,
  element,
  openDialog,
  showError,
  toggle,
} from "./components";
import { preview } from "./editor";
import { Store } from "./storage";
import { noteBody } from "./notemeta";
import { mimeFor } from "./attachments";

type Control =
  | HTMLButtonElement
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLTextAreaElement;

/**
 * Imports text, HTML, Markdown, DOCX, PDF text or images as a new note, like the Android app's import screen:
 * everything is converted in this browser, previewed, and saved with a title in a chosen folder. Resolves with the
 * new note's path, or null when cancelled.
 */
export async function importDialog(
  store: Store,
  folder: string,
  files?: File[],
): Promise<string | null> {
  const folders = (await store.list()).filter((note) => note.folder);
  return new Promise((resolve) => {
    let document: ImportedDocument | undefined,
      active = true,
      converting = false,
      committing = false,
      titleEdited = false,
      pastedPlain: string | undefined;
    const urls: string[] = [];
    const releaseUrls = () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.length = 0;
    };
    const modal = openDialog(
      "Import document",
      () => {
        active = false;
        releaseUrls();
        resolve(null);
      },
      "import-dialog",
    );
    const finish = (path: string | null) => {
      active = false;
      releaseUrls();
      modal.close();
      resolve(path);
    };
    const error = (cause: unknown) =>
      showError(
        modal.error,
        cause instanceof Error ? cause.message : String(cause),
      );
    const field = (label: string, input: HTMLElement) => {
      const wrapper = element("div", undefined, "field"),
        caption = element("label", label);
      caption.htmlFor = input.id;
      wrapper.append(caption, input);
      return wrapper;
    };

    const picker = element("input", undefined, "input");
    picker.type = "file";
    picker.id = "import-file";
    picker.multiple = true;
    picker.accept = IMPORT_ACCEPT;
    const source = element("textarea", undefined, "input");
    source.id = "import-source";
    source.rows = 5;
    const kind = element("select", undefined, "input");
    kind.id = "import-kind";
    for (const [value, label] of [
      ["text", "Plain text / Markdown"],
      ["html", "HTML"],
    ]) {
      const option = element("option", label);
      option.value = value;
      kind.append(option);
    }
    const title = element("input", undefined, "input");
    title.id = "import-title";
    title.value = DEFAULT_TITLE;
    title.addEventListener("input", () => (titleEdited = true));
    const destination = element("select", undefined, "input");
    destination.id = "import-folder";
    for (const path of ["", ...folders.map((note) => note.path)]) {
      const option = element("option", path ? `/${path}` : "My notes");
      option.value = path;
      destination.append(option);
    }
    destination.value = folder;
    const autoformat = toggle("Auto-format", true);
    autoformat.title =
      "Turn lists, headings, links and wrapped lines into Markdown. Markdown files and images are kept as they are.";
    const warnings = element("p", undefined, "hint");
    warnings.setAttribute("role", "status");
    const pane = element("article", undefined, "preview");
    pane.setAttribute("aria-label", "Import preview");

    const body = () => importBody(document!, checked(autoformat));
    const render = () => {
      releaseUrls();
      pane.replaceChildren();
      if (!document) return;
      pane.innerHTML = preview(noteBody(body()));
      for (const img of pane.querySelectorAll<HTMLImageElement>(
        "img[data-attachment]",
      )) {
        const path = img.dataset.attachment!;
        void (async () => {
          const image =
            document?.images.find((known) => known.path === path) ??
            (await store.attachment(path));
          if (!active || !pane.contains(img)) return;
          if (!image) {
            img.classList.add("missing");
            img.title =
              "This image is missing. Import it first before importing this note.";
            return;
          }
          const url = URL.createObjectURL(
            new Blob([image.bytes], { type: mimeFor(image.path) }),
          );
          urls.push(url);
          img.src = url;
        })().catch(error);
      }
    };
    autoformat.addEventListener("click", render);
    const invalidate = () => {
      document = undefined;
      warnings.textContent = "";
      create.disabled = true;
      render();
    };
    source.addEventListener("input", () => {
      pastedPlain = undefined;
      invalidate();
    });
    kind.addEventListener("change", invalidate);
    source.addEventListener("paste", (event) => {
      const html = event.clipboardData?.getData("text/html");
      if (!html) return;
      event.preventDefault();
      kind.value = "html";
      source.value = html;
      pastedPlain = event.clipboardData?.getData("text/plain") || undefined;
      invalidate();
    });

    const inputs: Control[] = [];
    const convert = async (work: () => Promise<ImportedDocument>) => {
      if (converting || committing) {
        error("Wait for the current conversion to finish.");
        return;
      }
      converting = true;
      invalidate();
      showError(modal.error, "");
      for (const input of inputs) input.disabled = true;
      warnings.textContent = "Converting in this browser…";
      try {
        const converted = await work();
        if (!active) return;
        document = converted;
        autoformat.disabled = !canFormat(converted);
        if (!titleEdited)
          title.value = suggestTitle(noteBody(body()), converted.fileName);
        warnings.textContent = converted.warnings.join(" ");
        render();
        create.disabled = false;
      } catch (cause) {
        if (active) {
          warnings.textContent = "";
          error(cause);
        }
      } finally {
        converting = false;
        for (const input of inputs) input.disabled = false;
      }
    };
    const chooseFiles = (chosen: File[]) => {
      if (chosen.length) void convert(() => importFiles(chosen));
    };
    picker.addEventListener("change", () => {
      chooseFiles([...(picker.files ?? [])]);
      picker.value = "";
    });
    modal.dialog.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    });
    modal.dialog.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      chooseFiles([...event.dataTransfer.files]);
    });
    const convertText = button(
      "Preview text",
      () =>
        void convert(async () =>
          kind.value === "html"
            ? importHtml(source.value, pastedPlain)
            : importText(source.value),
        ),
      { variant: "outline" },
    );
    inputs.push(picker, source, kind, convertText);

    const create = button(
      "Import note",
      () => {
        if (!document || converting || committing) return;
        const controls = [
          ...modal.dialog.querySelectorAll<Control>(
            "button,input,select,textarea",
          ),
        ];
        const states = controls.map((control) => control.disabled);
        committing = true;
        for (const control of controls) control.disabled = true;
        showError(modal.error, "");
        void store
          .importNote(
            destination.value,
            sanitizeTitle(title.value) || DEFAULT_TITLE,
            body(),
            document.images,
          )
          .then(finish, (cause: unknown) => {
            committing = false;
            controls.forEach((control, index) => {
              control.disabled = states[index];
            });
            error(cause);
          });
      },
      { variant: "solid" },
    );
    create.disabled = true;
    modal.dialog.addEventListener(
      "cancel",
      (event) => {
        if (committing) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    modal.body.append(
      element(
        "p",
        "Choose or drop a document and/or images, or paste text or HTML. Everything is converted in this browser; nothing is uploaded and no web images are downloaded.",
        "hint",
      ),
      field("Document or images", picker),
      field("Text format", kind),
      field("Text to import", source),
      convertText,
      field("Title", title),
      field("Folder", destination),
      autoformat,
      warnings,
      pane,
    );
    modal.footer.append(
      button("Cancel", () => finish(null), { variant: "outline" }),
      create,
    );
    if (files?.length) chooseFiles(files);
  });
}
