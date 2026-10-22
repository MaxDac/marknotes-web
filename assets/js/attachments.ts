/** Image attachments stored at `attachments/<sha256>.<ext>` under the notes root (see docs/note-format.md). */

export const ATTACHMENTS = "attachments";
export const MAX_SIDE = 2048;
export const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
export const ACCEPTED_TYPES = Object.keys(TYPES);
const PATH = /^attachments\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
const REFERENCE = /attachments\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)/g;

export const isAttachmentPath = (path: string): boolean => PATH.test(path);
/** Anything inside the reserved root folder, which is never a note or note folder. */
export const inAttachments = (path: string): boolean =>
  path === ATTACHMENTS || path.startsWith(`${ATTACHMENTS}/`);
export const attachmentHash = (path: string): string | undefined =>
  PATH.exec(path)?.[1];
export const extensionFor = (type: string): string | undefined => TYPES[type];
export function mimeFor(path: string): string {
  const ext = path.split(".").at(-1);
  return (
    Object.entries(TYPES).find(([, e]) => e === ext)?.[0] ??
    "application/octet-stream"
  );
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function attachmentPath(
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
): Promise<string> {
  const ext = extensionFor(type);
  if (!ext) throw new Error(unsupported);
  return `${ATTACHMENTS}/${await sha256(bytes)}.${ext}`;
}

/** Target dimensions so the longest side is at most `max`, or null when no resize is needed. */
export function scaledSize(
  width: number,
  height: number,
  max = MAX_SIDE,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= max) return null;
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function imageMarkdown(fileName: string, path: string): string {
  const alt = fileName
    .replace(/\.[^./]*$/, "")
    .replace(/[\\[\]]/g, (c) => `\\${c}`);
  return `![${alt}](${path})`;
}

/** Attachment paths referenced anywhere in the given note texts. */
export function referencedAttachments(texts: Iterable<string>): Set<string> {
  const refs = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(REFERENCE)) refs.add(match[0]);
  return refs;
}

const unsupported = "Only PNG, JPEG, GIF and WebP images can be inserted.";

export interface ProcessedImage {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}
/** Validates, downscales (except GIFs) and names an image file for storage. */
export async function processImage(file: Blob): Promise<ProcessedImage> {
  if (!extensionFor(file.type)) throw new Error(unsupported);
  let blob: Blob = file;
  if (file.type !== "image/gif") {
    const bitmap = await createImageBitmap(file);
    try {
      const size = scaledSize(bitmap.width, bitmap.height);
      if (size) {
        const canvas = new OffscreenCanvas(size.width, size.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser cannot resize images.");
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        const resized = await canvas.convertToBlob({
          type: file.type,
          quality: 0.9,
        });
        // Browsers that cannot encode the original format fall back to PNG.
        if (extensionFor(resized.type)) blob = resized;
      }
    } finally {
      bitmap.close();
    }
  }
  if (blob.size > MAX_BYTES)
    throw new Error(
      "This image is larger than 10 MB even after resizing. Choose a smaller image.",
    );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { path: await attachmentPath(bytes, blob.type), bytes };
}
