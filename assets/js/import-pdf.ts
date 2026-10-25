import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 500;
/** A vertical gap this many line heights wide separates paragraphs. */
const PARAGRAPH_GAP = 1.8;

interface Line {
  text: string;
  y: number;
  height: number;
}

/**
 * Extracts the text of a PDF in this browser (like Android, text only: no images or OCR). Lines are separated by
 * newlines and paragraphs, detected from larger vertical gaps, by blank lines, so the text can then be reflowed.
 */
export async function pdfText(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const task = getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    // Never fetch fonts, CMaps, WASM decoders or document-supplied URLs.
    cMapUrl: undefined,
    standardFontDataUrl: undefined,
    stopAtErrors: true,
  });
  try {
    const password = new Promise<never>((_resolve, reject) => {
      task.onPassword = () =>
        reject(
          new Error(
            "Password-protected PDFs can't be imported. Choose an unlocked copy.",
          ),
        );
    });
    const pdf = await Promise.race([task.promise, password]);
    if (pdf.numPages > MAX_PAGES)
      throw new Error(`Import PDFs with at most ${MAX_PAGES} pages.`);
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const lines: Line[] = [];
      let current: Line | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        current ??= {
          text: "",
          y: item.transform[5],
          height: item.height || Math.abs(item.transform[3]),
        };
        current.text += item.str;
        if (item.hasEOL) {
          lines.push(current);
          current = undefined;
        }
      }
      if (current) lines.push(current);
      let text = "";
      lines.forEach((line, index) => {
        const previous = lines[index - 1];
        if (previous) {
          const gap = Math.abs(previous.y - line.y);
          const height = Math.max(previous.height, line.height, 1);
          text += gap > height * PARAGRAPH_GAP ? "\n\n" : "\n";
        }
        text += line.text.trimEnd();
      });
      pages.push(text.trim());
      page.cleanup();
    }
    const text = pages.filter(Boolean).join("\n\n");
    if (!text.trim())
      throw new Error(
        "This PDF contains no text to import. Scanned pages would need OCR, which isn't supported.",
      );
    return text;
  } finally {
    await task.destroy();
  }
}
