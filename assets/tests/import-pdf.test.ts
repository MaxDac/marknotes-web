import { beforeEach, describe, expect, it, vi } from "vitest";

interface Item {
  str: string;
  transform: number[];
  height: number;
  hasEOL: boolean;
}
type Page = (Item | { type: string })[];

const pdfjs = vi.hoisted(() => ({
  pages: [] as Page[],
  numPages: undefined as number | undefined,
  password: false,
  failure: undefined as Error | undefined,
  options: undefined as Record<string, unknown> | undefined,
  destroyed: 0,
  cleaned: 0,
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/assets/pdf.worker.js",
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: pdfjs.GlobalWorkerOptions,
  getDocument(options: Record<string, unknown>) {
    pdfjs.options = options;
    const task = {
      onPassword: undefined as (() => void) | undefined,
      promise: new Promise((resolve, reject) =>
        setTimeout(() => {
          if (pdfjs.password) return task.onPassword?.();
          if (pdfjs.failure) return reject(pdfjs.failure);
          resolve({
            numPages: pdfjs.numPages ?? pdfjs.pages.length,
            getPage: async (number: number) => ({
              getTextContent: async () => ({ items: pdfjs.pages[number - 1] }),
              cleanup: () => pdfjs.cleaned++,
            }),
          });
        }),
      ),
      destroy: async () => {
        pdfjs.destroyed++;
      },
    };
    return task;
  },
}));

const { pdfText } = await import("../js/import-pdf");

/** A text run at baseline `y`; `eol` ends the line. */
const run = (str: string, y: number, eol = true, height = 10): Item => ({
  str,
  transform: [1, 0, 0, height, 0, y],
  height,
  hasEOL: eol,
});
const bytes = new Uint8Array([37, 80, 68, 70]);

beforeEach(() => {
  Object.assign(pdfjs, {
    pages: [],
    numPages: undefined,
    password: false,
    failure: undefined,
    options: undefined,
    destroyed: 0,
    cleaned: 0,
  });
});

describe("pdfText", () => {
  it("never lets the PDF fetch fonts, CMaps or decoders", async () => {
    pdfjs.pages = [[run("Hello", 700)]];
    expect(await pdfText(bytes)).toBe("Hello");
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.js");
    expect(pdfjs.options).toMatchObject({
      data: bytes,
      useSystemFonts: false,
      disableFontFace: true,
      useWasm: false,
      cMapUrl: undefined,
      standardFontDataUrl: undefined,
      stopAtErrors: true,
    });
    expect(pdfjs.destroyed).toBe(1);
  });

  it("joins runs into lines and separates paragraphs by larger gaps", async () => {
    pdfjs.pages = [
      [
        run("First ", 700, false),
        { type: "beginMarkedContent" },
        run("line   ", 700),
        run("second line", 688),
        // 40 units below a 10 unit line is a new paragraph.
        run("New paragraph", 648),
        // Heights of 0 fall back to the transform's vertical scale.
        { ...run("Tail", 636), height: 0 },
      ],
      [],
      [run("Page two", 700, false)],
    ];
    expect(await pdfText(bytes)).toBe(
      "First line\nsecond line\n\nNew paragraph\nTail\n\nPage two",
    );
    expect(pdfjs.cleaned).toBe(3);
  });

  it("refuses password-protected PDFs", async () => {
    pdfjs.password = true;
    await expect(pdfText(bytes)).rejects.toThrow(
      "Password-protected PDFs can't be imported.",
    );
    expect(pdfjs.destroyed).toBe(1);
  });

  it("refuses PDFs with too many pages before reading them", async () => {
    pdfjs.numPages = 501;
    await expect(pdfText(bytes)).rejects.toThrow(
      "Import PDFs with at most 500 pages.",
    );
    expect(pdfjs.cleaned).toBe(0);
    expect(pdfjs.destroyed).toBe(1);
  });

  it("explains that scanned PDFs without text need OCR", async () => {
    pdfjs.pages = [[run("   ", 700)], []];
    await expect(pdfText(bytes)).rejects.toThrow("would need OCR");
  });

  it("releases the document when parsing fails", async () => {
    pdfjs.failure = new Error("Invalid PDF structure.");
    await expect(pdfText(bytes)).rejects.toThrow("Invalid PDF structure.");
    expect(pdfjs.destroyed).toBe(1);
  });
});
