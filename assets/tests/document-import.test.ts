// @vitest-environment jsdom
import { Blob, File } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canFormat,
  importBody,
  importFiles,
  importHtml,
  importText,
  MAX_DOCUMENT_BYTES,
  MAX_TEXT_BYTES,
} from "../js/document-import";
import { attachmentPath } from "../js/attachments";
import { docxFixture } from "../e2e/import-fixtures";

const GIF = new Uint8Array(
  Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  ),
);
const file = (
  parts: (string | Uint8Array<ArrayBuffer>)[],
  name: string,
  type = "",
) => new File(parts, name, { type }) as unknown as globalThis.File;
const sized = (name: string, size: number) =>
  ({ name, size, type: "" }) as globalThis.File;

beforeEach(() => vi.stubGlobal("Blob", Blob));
afterEach(() => vi.unstubAllGlobals());

describe("HTML conversion", () => {
  it("converts inert HTML and never runs or fetches anything", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const converted = await importHtml(
      "<h1>Private</h1><p>Hello <strong>world</strong></p><ul><li>one</li></ul>" +
        '<img src="https://example.invalid/private.png" onerror="alert(1)" alt="Remote">' +
        '<img src="file:///etc/secret.png" alt="Local">' +
        '<iframe src="https://example.invalid/frame"></iframe><script>fetch("/leak")</script>' +
        '<a href="javascript:alert(1)" onclick="x()">unsafe</a>',
    );
    const body = importBody(converted, true);
    expect(body).toContain("# Private");
    expect(body).toContain("**world**");
    expect(body).toMatch(/^- +one$/m);
    // Web images become links to them, like on Android; nothing is downloaded.
    expect(body).toContain("[Remote](https://example.invalid/private.png)");
    expect(body).not.toMatch(
      /!\[Remote|javascript:|onerror|onclick|iframe|fetch|file:/,
    );
    expect(converted.warnings.join(" ")).toContain("links");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps HTML as plain text, preferring the plain text shared with it (Android parity)", async () => {
    const html = "<p><b>Hi</b></p>";
    expect(importBody(await importHtml(html, "Hi there"), false)).toBe(
      "Hi there\n",
    );
    expect(importBody(await importHtml(html, "Hi there"), true)).toBe(
      "**Hi**\n",
    );
    expect(importBody(await importHtml(html), false)).toBe("Hi\n");
  });

  it("stores inline images as attachments without saving anything yet", async () => {
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
    const converted = await importHtml(
      '<p>Picture</p><img src="data:image/gif;base64,R0lGODlh" alt="Chart">',
    );
    const path = await attachmentPath(bytes, "image/gif");
    expect(converted.images).toEqual([{ path, bytes }]);
    for (const autoformat of [true, false]) {
      const body = importBody(converted, autoformat);
      expect(body).toContain(`![Chart](${path})`);
      expect(body).not.toContain("data:");
    }
  });

  it("converts tables, flattening merged cells with a warning", async () => {
    const converted = await importHtml(
      '<table><tr><th>Name</th><th>Image</th></tr><tr><td><strong>Sample</strong></td><td colspan="1"><img src="data:image/gif;base64,R0lGODlh"></td></tr></table>',
    );
    const body = importBody(converted, true);
    expect(body).toContain("| Name | Image |\n| --- | --- |");
    expect(body).toContain("**Sample**");
    expect(body).toContain(converted.images[0].path);
    expect(importBody(converted, false)).toContain(converted.images[0].path);
    expect(converted.warnings.join(" ")).toContain("Merged");
  });

  it("rejects HTML without content", async () => {
    await expect(importHtml("<script>secret()</script>")).rejects.toThrow(
      "no text",
    );
  });
});

describe("file and text imports", () => {
  it("auto-formats text or keeps it as it is (Android parity)", () => {
    const converted = importText("• Milk\r\nURGENT\n\n*not emphasis*");
    expect(canFormat(converted)).toBe(true);
    expect(importBody(converted, false)).toBe(
      "• Milk\nURGENT\n\n*not emphasis*\n",
    );
    expect(importBody(converted, true)).toBe(
      "- Milk\n\nURGENT\n\n\\*not emphasis\\*\n",
    );
    expect(() => importText("  ")).toThrow("Paste or enter");
  });

  it("never reformats Markdown files", async () => {
    const text = "---\nid: abcdefgh\n---\n# Café\r\n\r\n• item\r\n2) next\r\n";
    const converted = await importFiles([
      file([new TextEncoder().encode(text)], "Example.md"),
    ]);
    expect(converted.fileName).toBe("Example.md");
    expect(canFormat(converted)).toBe(false);
    const expected = "---\nid: abcdefgh\n---\n# Café\n\n• item\n2) next\n";
    expect(importBody(converted, true)).toBe(expected);
    expect(importBody(converted, false)).toBe(expected);
  });

  it("imports .txt and .html files", async () => {
    const txt = await importFiles([file(["1) First\n2) Second"], "list.txt")]);
    expect(importBody(txt, true)).toBe("1. First\n2. Second\n");
    expect(importBody(txt, false)).toBe("1) First\n2) Second\n");
    const html = await importFiles([
      file(["<h2>Page</h2><p>Body</p>"], "page.htm", "text/html"),
    ]);
    expect(importBody(html, true)).toBe("## Page\n\nBody\n");
  });

  it("converts DOCX text and its images", async () => {
    const bytes = new Uint8Array(docxFixture());
    // A same-realm ArrayBuffer: the zip reader rejects Node's under jsdom.
    const docx = {
      name: "Report.docx",
      size: bytes.length,
      type: "",
      arrayBuffer: async () => bytes.buffer,
    } as globalThis.File;
    const converted = await importFiles([docx]);
    expect(converted.images).toHaveLength(1);
    const body = importBody(converted, true);
    expect(body).toContain("DOCX private text");
    expect(body).toContain(`](${converted.images[0].path})`);
    expect(importBody(converted, false)).toContain(converted.images[0].path);
  });

  it("adds images after the document and skips unreadable ones", async () => {
    const converted = await importFiles([
      file(["Some text"], "notes.txt"),
      file([GIF], "picture.gif"),
      file([new Uint8Array([1, 2, 3])], "broken.png", "image/png"),
    ]);
    const path = await attachmentPath(new Uint8Array(GIF), "image/gif");
    expect(converted.images.map((image) => image.path)).toEqual([path]);
    expect(importBody(converted, true)).toBe(
      `Some text\n\n![picture](${path})\n`,
    );
    expect(converted.warnings).toContain(
      "1 image could not be read and was skipped.",
    );
    const images = await importFiles([file([GIF], "Only.GIF")]);
    expect(canFormat(images)).toBe(false);
    expect(images.fileName).toBe("Only.GIF");
  });

  it("reports unsupported, oversized, invalid and ambiguous imports", async () => {
    await expect(importFiles([sized("file.zip", 1)])).rejects.toThrow(
      "Choose a TXT",
    );
    await expect(
      importFiles([sized("huge.txt", MAX_TEXT_BYTES + 1)]),
    ).rejects.toThrow("5 MB");
    await expect(
      importFiles([sized("huge.pdf", MAX_DOCUMENT_BYTES + 1)]),
    ).rejects.toThrow("50 MB");
    await expect(
      importFiles([file([new Uint8Array([0xff])], "invalid.txt")]),
    ).rejects.toThrow("UTF-8");
    await expect(importFiles([file([""], "empty.txt")])).rejects.toThrow(
      "empty",
    );
    await expect(
      importFiles([file(["not a zip"], "broken.docx")]),
    ).rejects.toThrow("DOCX");
    await expect(
      importFiles([file(["a"], "a.txt"), file(["b"], "b.md")]),
    ).rejects.toThrow("one document");
    await expect(
      importFiles([file([new Uint8Array([1])], "broken.png", "image/png")]),
    ).rejects.toThrow();
  });
});
