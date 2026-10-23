import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentPath,
  imageMarkdown,
  inAttachments,
  isAttachmentPath,
  mimeFor,
  processImage,
  referencedAttachments,
  scaledSize,
} from "../js/attachments";
import { Store, type Account } from "../js/storage";
import { SyncEngine, syncAll } from "../js/sync";
import { FakeDrive } from "./fake-drive";

const bytes = (text: string) => new TextEncoder().encode(text);
const EMPTY_SHA =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("attachment helpers", () => {
  it("names files by SHA-256 of their bytes with a MIME-derived extension", async () => {
    expect(await attachmentPath(new Uint8Array(0), "image/png")).toBe(
      `attachments/${EMPTY_SHA}.png`,
    );
    expect(await attachmentPath(new Uint8Array(0), "image/jpeg")).toMatch(
      /\.jpg$/,
    );
    await expect(
      attachmentPath(new Uint8Array(0), "image/svg+xml"),
    ).rejects.toThrow(/PNG, JPEG, GIF and WebP/);
    expect(mimeFor(`attachments/${EMPTY_SHA}.webp`)).toBe("image/webp");
  });
  it("recognises only canonical attachment paths", () => {
    expect(isAttachmentPath(`attachments/${EMPTY_SHA}.gif`)).toBe(true);
    expect(isAttachmentPath(`attachments/${EMPTY_SHA}.svg`)).toBe(false);
    expect(isAttachmentPath(`notes/attachments/${EMPTY_SHA}.png`)).toBe(false);
    expect(isAttachmentPath("attachments/x.png")).toBe(false);
    expect(inAttachments("attachments")).toBe(true);
    expect(inAttachments("attachments/a.md")).toBe(true);
    expect(inAttachments("attachmentsX/a.md")).toBe(false);
  });
  it("downscales so the longest side is at most 2048 px", () => {
    expect(scaledSize(2048, 1000)).toBeNull();
    expect(scaledSize(4096, 1024)).toEqual({ width: 2048, height: 512 });
    expect(scaledSize(1000, 5000)).toEqual({ width: 410, height: 2048 });
  });
  it("builds root-relative markdown and finds references", () => {
    const path = `attachments/${EMPTY_SHA}.png`;
    expect(imageMarkdown("Holiday [1].photo.png", path)).toBe(
      `![Holiday \\[1\\].photo](${path})`,
    );
    expect(
      referencedAttachments([`a ![x](${path}) b`, "none", `<${path}>`]),
    ).toEqual(new Set([path]));
  });
  it("rejects unsupported and oversized images", async () => {
    await expect(
      processImage(new Blob(["x"], { type: "image/svg+xml" })),
    ).rejects.toThrow(/PNG, JPEG, GIF and WebP/);
    const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], {
      type: "image/gif",
    });
    await expect(processImage(big)).rejects.toThrow(/larger than 10 MB/);
    const gif = await processImage(new Blob(["GIF89a"], { type: "image/gif" }));
    expect(gif.path).toMatch(/^attachments\/[0-9a-f]{64}\.gif$/);
    expect(new TextDecoder().decode(gif.bytes)).toBe("GIF89a");
  });
});

describe("attachment storage and sync", () => {
  const account: Account = {
    id: "a",
    provider: "dropbox",
    subject: "a",
    label: "test",
    folder: "MarkNotes",
  };
  let store: Store, remote: FakeDrive;
  beforeEach(async () => {
    store = await Store.open(crypto.randomUUID());
    remote = new FakeDrive();
  });
  afterEach(() => store.close());

  it("uploads, lists in the manifest and never touches attachments as notes", async () => {
    const data = bytes("png-bytes");
    const path = await attachmentPath(data, "image/png");
    await store.putAttachment(path, data);
    await store.write("n.md", `![p](${path})`);
    const result = await new SyncEngine(store, account, remote).run();
    expect(result.errors).toEqual([]);
    expect(remote.data.get(path)?.bytes).toEqual(data);
    const manifest = JSON.parse(remote.manifest!);
    expect(manifest.format).toBe(1);
    expect(manifest.files[path].sha256).toBe(path.slice(12, 76));
    expect((await store.list()).map((n) => n.path)).toEqual(["n.md"]);
    remote.uploads = [];
    await new SyncEngine(store, account, remote).run();
    expect(remote.uploads).toEqual([]);
  });
  it("downloads remote attachments after verifying their hash", async () => {
    const data = bytes("remote image");
    const path = await attachmentPath(data, "image/webp");
    await remote.upload(path, data);
    const bad = `attachments/${"0".repeat(64)}.png`;
    await remote.upload(bad, bytes("tampered"));
    await remote.upload("attachments/readme.md", "not a note");
    const result = await new SyncEngine(store, account, remote).run();
    expect((await store.attachment(path))?.bytes).toEqual(data);
    expect(await store.attachment(bad)).toBeUndefined();
    expect(result.errors).toEqual([
      `${bad}: content does not match its name; skipped`,
    ]);
    expect((await store.list()).map((n) => n.path)).toEqual([]);
  });
  it("syncs only attachments named by their hash, and keeps no base copy of them", async () => {
    const data = bytes("img");
    const path = await attachmentPath(data, "image/png");
    await store.putAttachment(path, data);
    await store.putAttachment("attachments/photo.png", data);
    await remote.upload("attachments/holiday.jpg", data);
    const result = await new SyncEngine(store, account, remote).run();
    expect(result.errors).toEqual([]);
    expect(remote.data.has(path)).toBe(true);
    expect(remote.data.has("attachments/photo.png")).toBe(false);
    expect(await store.attachment("attachments/holiday.jpg")).toBeUndefined();
    expect(await store.base("a", path)).toBeUndefined();
  });
  it("propagates deletions both ways and to every linked drive", async () => {
    const other = new FakeDrive(),
      second = { ...account, id: "b" };
    const data = bytes("img");
    const path = await attachmentPath(data, "image/gif");
    await store.putAttachment(path, data);
    const targets = [
      { account, remote },
      { account: second, remote: other },
    ];
    await syncAll(store, targets);
    expect(other.data.has(path)).toBe(true);
    await store.deleteAttachment(path);
    await syncAll(store, targets);
    expect(remote.data.has(path)).toBe(false);
    expect(other.data.has(path)).toBe(false);
    await store.putAttachment(path, data);
    await syncAll(store, targets);
    remote.data.delete(path);
    await syncAll(store, targets);
    expect(await store.attachment(path)).toBeUndefined();
    expect(other.data.has(path)).toBe(false);
  });
});
