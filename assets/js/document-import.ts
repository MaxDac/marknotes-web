import DOMPurify from "dompurify";
import TurndownService from "turndown";
import {
  ACCEPTED_TYPES,
  imageMarkdown,
  processImage,
  type ProcessedImage,
} from "./attachments";
import { normalize, plainTextToMarkdown, tidy } from "./import-format";

export const IMPORT_ACCEPT =
  ".txt,.text,.md,.markdown,.html,.htm,.docx,.pdf,.png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp";
/** Same limits as the Android app: text-like files are small, documents may be large. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_EXPANDED = 100 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 2000;
const MB = 1024 * 1024;

/**
 * One piece of imported content. Like the Android app, plain text and HTML can be auto-formatted into Markdown or
 * kept as they are; Markdown files are never reformatted; images become attachment references.
 */
export type ImportPart =
  | { kind: "text"; text: string; reflow?: boolean }
  | { kind: "markdown"; text: string }
  | { kind: "html"; markdown: string; plain: string }
  | { kind: "image"; markdown: string };

export interface ImportedDocument {
  /** Name of the imported file, used to suggest a title. */
  fileName?: string;
  parts: ImportPart[];
  /** Attachments referenced by the parts, saved only if the final note still references them. */
  images: ProcessedImage[];
  warnings: string[];
}

/** Auto-format only changes text and HTML; Markdown files and images are imported as they are. */
export const canFormat = (document: ImportedDocument): boolean =>
  document.parts.some((part) => part.kind === "text" || part.kind === "html");

function renderPart(part: ImportPart, autoformat: boolean): string {
  switch (part.kind) {
    case "text":
      return autoformat
        ? plainTextToMarkdown(part.text, part.reflow)
        : tidy(normalize(part.text));
    case "markdown":
      return tidy(normalize(part.text));
    case "html":
      return tidy(normalize(autoformat ? part.markdown : part.plain));
    case "image":
      return part.markdown;
  }
}

/** The note body for `document`, with or without auto-formatting. */
export function importBody(
  document: ImportedDocument,
  autoformat: boolean,
): string {
  return tidy(
    document.parts
      .map((part) => renderPart(part, autoformat))
      .filter((text) => text.trim())
      .join("\n\n"),
  );
}

const extension = (name: string) =>
  /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const isImage = (file: File) =>
  ACCEPTED_TYPES.includes(file.type) ||
  (!file.type && extension(file.name) in IMAGE_EXTENSIONS);
const sizeLimit = (bytes: number, limit: number, what: string) => {
  if (bytes > limit)
    throw new Error(`Choose ${what} smaller than ${limit / MB} MB.`);
};

function decodeText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This file is not UTF-8 text.");
  }
}

/** Plain or Markdown text typed or pasted into the import dialog. */
export function importText(text: string): ImportedDocument {
  sizeLimit(new TextEncoder().encode(text).length, MAX_TEXT_BYTES, "text");
  if (!text.trim()) throw new Error("Paste or enter some text first.");
  return { parts: [{ kind: "text", text }], images: [], warnings: [] };
}

const SAFE_HREF = /^(https?:|mailto:|marknotes:|#)/i;
const ACTIVE_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "svg",
  "math",
  "audio",
  "video",
  "source",
  "picture",
  "canvas",
]);
const WEB_IMAGE = /^https?:\/\//i;
const DATA_IMAGE =
  /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i;

function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") ?? "";
    return src.startsWith("attachments/")
      ? `\n${imageMarkdown(node.getAttribute("alt") || "Image", src)}\n`
      : "";
  }
  const body = [...node.childNodes].map(plainText).join("");
  if (/^(TD|TH)$/.test(node.tagName)) return `${body}\t`;
  return /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|BR|TR|TABLE|SECTION|ARTICLE)$/.test(
    node.tagName,
  )
    ? `${body}\n`
    : body;
}

function markdown(container: HTMLElement): string {
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  converter.addRule("tables", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = [...(node as HTMLTableElement).rows].map((row) =>
        [...row.cells].map((cell) =>
          converter
            .turndown(cell)
            .trim()
            .replace(/\s+/g, " ")
            // Escape cell pipes for GFM unless a backslash (not itself escaped) already does.
            .replace(/(?<!\\)((?:\\\\)*)\|/g, "$1\\|"),
        ),
      );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) =>
        `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
      return `\n\n${[line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`;
    },
  });
  return converter.turndown(container);
}

/**
 * Converts `html` (pasted, shared, an `.html` file or a converted `.docx`) inside an inert template, so scripts never
 * run and nothing is fetched. Inline `data:` images become attachments; web images become links to them, as on
 * Android. `plain` is the plain text that came with the HTML (the clipboard's text), used when not auto-formatting.
 */
export async function importHtml(
  html: string,
  plain?: string,
): Promise<ImportedDocument> {
  sizeLimit(new TextEncoder().encode(html).length, MAX_DOCUMENT_BYTES, "HTML");
  // Sanitized first, then parsed into a document with no browsing context, where nothing loads or runs. Every node
  // stays in it, since adopting an <img> into this page's document would start loading its src.
  const sanitizer = DOMPurify(window);
  const clean = sanitizer.sanitize(html, {
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|marknotes):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: [...ACTIVE_TAGS],
  });
  const inert = new DOMParser().parseFromString(clean, "text/html");
  const content = inert.body;
  const result: ImportedDocument = { parts: [], images: [], warnings: [] };
  if (
    sanitizer.removed.some(
      (entry) =>
        "element" in entry &&
        ACTIVE_TAGS.has(entry.element.nodeName.toLowerCase()),
    )
  )
    result.warnings.push(
      "Scripts, styles, forms and embedded media were removed.",
    );
  for (const img of content.querySelectorAll("img")) {
    const src = img.getAttribute("src")?.trim() ?? "";
    const alt = img.getAttribute("alt")?.trim() ?? "";
    const data = DATA_IMAGE.exec(src);
    if (data) {
      try {
        const bytes = Uint8Array.from(atob(data[2].replace(/\s/g, "")), (c) =>
          c.charCodeAt(0),
        );
        const image = await processImage(
          new Blob([bytes], { type: data[1].toLowerCase() }),
        );
        if (!result.images.some((known) => known.path === image.path))
          result.images.push(image);
        // Turndown only sees the validated attachment reference, never the original data.
        for (const attribute of [...img.attributes])
          img.removeAttribute(attribute.name);
        img.setAttribute("src", image.path);
        img.setAttribute("alt", alt || "Image");
        continue;
      } catch {
        result.warnings.push(
          "An embedded image could not be read and was left out.",
        );
      }
    } else if (WEB_IMAGE.test(src)) {
      const anchor = inert.createElement("a");
      anchor.setAttribute("href", src);
      anchor.textContent = alt || "Image";
      img.replaceWith(anchor);
      result.warnings.push(
        "Web images were kept as links; nothing was downloaded.",
      );
      continue;
    } else if (src) {
      result.warnings.push(
        "Linked images that aren't on the web were left out.",
      );
    }
    img.replaceWith(inert.createTextNode(alt));
  }
  for (const anchor of content.querySelectorAll("a")) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    for (const attribute of [...anchor.attributes])
      if (attribute.name !== "href") anchor.removeAttribute(attribute.name);
    if (!SAFE_HREF.test(href)) anchor.removeAttribute("href");
  }
  if (content.querySelector("[rowspan],[colspan]"))
    result.warnings.push(
      "Merged table cells were flattened; check the table in the preview.",
    );
  const part: ImportPart = {
    kind: "html",
    markdown: markdown(content),
    plain: plain?.trim() ? plain : plainText(content),
  };
  if (!part.markdown.trim() && !part.plain.trim())
    throw new Error("This document contains no text or images to import.");
  result.parts.push(part);
  result.warnings = [...new Set(result.warnings)];
  return result;
}

/** Rejects archives whose declared expansion is too large before the converter decompresses them. */
function validateDocxArchive(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  for (
    let end = view.byteLength - 22;
    end >= Math.max(0, view.byteLength - 65557);
    end--
  ) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true),
      expanded = 0;
    if (count > MAX_DOCX_ENTRIES)
      throw new Error("This DOCX contains too many archive entries.");
    for (let index = 0; index < count; index++) {
      if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
        throw new Error("This DOCX archive is invalid.");
      expanded += view.getUint32(offset + 24, true);
      if (expanded > MAX_DOCX_EXPANDED)
        throw new Error(
          `This DOCX expands beyond the ${MAX_DOCX_EXPANDED / MB} MB import limit.`,
        );
      offset +=
        46 +
        view.getUint16(offset + 28, true) +
        view.getUint16(offset + 30, true) +
        view.getUint16(offset + 32, true);
    }
    return;
  }
  throw new Error("This file is not a valid DOCX document.");
}

async function importDocumentFile(file: File): Promise<ImportedDocument> {
  const ext = extension(file.name);
  const fileName = file.name;
  if (ext === "docx") {
    sizeLimit(file.size, MAX_DOCUMENT_BYTES, "a document");
    const arrayBuffer = await file.arrayBuffer();
    validateDocxArchive(arrayBuffer);
    const mammoth = await import("mammoth/mammoth.browser");
    const converted = await mammoth.convertToHtml(
      { arrayBuffer },
      { externalFileAccess: false },
    );
    const result = await importHtml(converted.value);
    if (converted.messages.some((message) => message.type === "error"))
      result.warnings.push(
        "Some parts of this document could not be converted.",
      );
    return { ...result, fileName };
  }
  if (ext === "pdf") {
    sizeLimit(file.size, MAX_DOCUMENT_BYTES, "a document");
    const { pdfText } = await import("./import-pdf");
    const text = await pdfText(new Uint8Array(await file.arrayBuffer()));
    return {
      fileName,
      parts: [{ kind: "text", text, reflow: true }],
      images: [],
      warnings: [
        "Only the text of PDFs is imported; images, tables and layout are not.",
      ],
    };
  }
  if (!["txt", "text", "md", "markdown", "html", "htm"].includes(ext))
    throw new Error(
      "Choose a TXT, Markdown, HTML, DOCX, PDF, PNG, JPEG, GIF or WebP file.",
    );
  sizeLimit(file.size, MAX_TEXT_BYTES, "a text file");
  const text = decodeText(await file.arrayBuffer());
  if (ext === "html" || ext === "htm")
    return { ...(await importHtml(text)), fileName };
  if (!text.trim()) throw new Error("This file is empty.");
  const markdownFile = ext === "md" || ext === "markdown";
  return {
    fileName,
    parts: [markdownFile ? { kind: "markdown", text } : { kind: "text", text }],
    images: [],
    warnings:
      markdownFile && text.includes("![")
        ? ["Images referenced by this Markdown file are not imported with it."]
        : [],
  };
}

/**
 * Imports one document (text, Markdown, HTML, DOCX or PDF) and any number of images, all converted in this browser.
 * Images that can't be read are skipped with a warning, like on Android.
 */
export async function importFiles(files: File[]): Promise<ImportedDocument> {
  if (!files.length) throw new Error("Choose a file to import.");
  const images = files.filter(isImage);
  const documents = files.filter((file) => !isImage(file));
  if (documents.length > 1)
    throw new Error(
      "Import one document at a time; images can be added alongside it.",
    );
  const result: ImportedDocument = documents.length
    ? await importDocumentFile(documents[0])
    : { fileName: images[0].name, parts: [], images: [], warnings: [] };
  let skipped = 0,
    failure: unknown;
  for (const file of images) {
    try {
      sizeLimit(file.size, MAX_DOCUMENT_BYTES, "images");
      const blob = file.type
        ? file
        : new Blob([file], { type: IMAGE_EXTENSIONS[extension(file.name)] });
      const image = await processImage(blob);
      if (!result.images.some((known) => known.path === image.path))
        result.images.push(image);
      result.parts.push({
        kind: "image",
        markdown: imageMarkdown(file.name, image.path),
      });
    } catch (error) {
      skipped++;
      failure ??= error;
    }
  }
  if (!result.parts.length) throw failure;
  if (skipped)
    result.warnings.push(
      skipped === 1
        ? "1 image could not be read and was skipped."
        : `${skipped} images could not be read and were skipped.`,
    );
  return result;
}
