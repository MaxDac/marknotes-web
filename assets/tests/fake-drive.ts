import type { Content, Entry, Remote } from "../js/sync";
import { foldCase } from "@marknotes/sync";
export class FakeDrive implements Remote {
  data = new Map<
    string,
    { entry: Entry; text: string; bytes?: Uint8Array<ArrayBuffer> }
  >();
  uploads: string[] = [];
  manifest: string | null = null;
  writes = 0;
  revision = 0;
  fail = false;
  /** Paths whose upload fails. */
  failing = new Set<string>();
  /** Runs after the engine listed the local tree, before it plans: simulates an edit racing the sync. */
  onSnapshot?: () => Promise<void>;
  /** Runs before a download returns: simulates an edit racing the apply step. */
  onDownload?: (path: string) => Promise<void>;
  async snapshot(): Promise<Entry[]> {
    if (this.fail) throw new Error("Unavailable");
    await this.onSnapshot?.();
    return [...this.data.values()].map((n) => ({ ...n.entry }));
  }
  async downloadBytes(entry: Entry): Promise<Uint8Array<ArrayBuffer>> {
    await this.onDownload?.(entry.path);
    const item = this.data.get(entry.path)!;
    return item.bytes ?? new TextEncoder().encode(item.text);
  }
  async upload(
    path: string,
    content: Content,
    previous?: Entry,
    modifiedAt = Date.now(),
  ): Promise<Entry> {
    const old = this.data.get(path);
    if (
      !previous &&
      [...this.data.keys()].some((p) => foldCase(p) === foldCase(path))
    )
      throw new Error("Revision conflict");
    if (this.failing.has(path)) throw new Error("Upload failed");
    if (old && old.entry.version !== previous?.version)
      throw new Error("Revision conflict");
    const entry = {
      path,
      id: old?.entry.id ?? crypto.randomUUID(),
      folder: false,
      version: String(++this.revision),
      modifiedAt,
    };
    this.uploads.push(path);
    this.data.set(
      path,
      typeof content === "string"
        ? { entry, text: content }
        : { entry, text: "", bytes: content },
    );
    return entry;
  }
  async mkdir(path: string): Promise<Entry> {
    if ([...this.data.keys()].some((p) => foldCase(p) === foldCase(path)))
      throw new Error("Destination already exists");
    return this.ensureFolder(path);
  }
  async ensureFolder(path: string): Promise<Entry> {
    const old = this.data.get(path);
    if (old) {
      if (!old.entry.folder) throw new Error("A file blocks the cloud folder.");
      return old.entry;
    }
    const entry = { path, id: crypto.randomUUID(), folder: true, version: "" };
    this.data.set(path, { entry, text: "" });
    return entry;
  }
  /** Like the real drives, file deletes are conditional on the snapshot revision. */
  async delete(entry: Entry): Promise<void> {
    if (
      entry.folder &&
      [...this.data.keys()].some((p) => p.startsWith(`${entry.path}/`))
    )
      throw new Error("Folder is not empty");
    const current = this.data.get(entry.path);
    if (
      current &&
      (current.entry.id !== entry.id ||
        (!entry.folder && current.entry.version !== entry.version))
    )
      throw new Error("Revision conflict");
    this.data.delete(entry.path);
  }
  async readManifest(): Promise<string | null> {
    return this.manifest;
  }
  async rename(entry: Entry, toPath: string): Promise<Entry> {
    const old = this.data.get(entry.path);
    if (
      !old ||
      old.entry.id !== entry.id ||
      old.entry.version !== entry.version
    )
      throw new Error("Revision conflict");
    if (this.data.has(toPath)) throw new Error("Destination already exists");
    for (const path of [...this.data.keys()]) {
      if (path !== entry.path && !path.startsWith(`${entry.path}/`)) continue;
      const value = this.data.get(path)!;
      this.data.delete(path);
      const target = toPath + path.slice(entry.path.length);
      this.data.set(target, {
        ...value,
        entry: { ...value.entry, path: target },
      });
    }
    return this.data.get(toPath)!.entry;
  }
  async writeManifest(text: string): Promise<void> {
    this.manifest = text;
    this.writes++;
  }
  async edit(path: string, text: string, modifiedAt?: number): Promise<void> {
    await this.upload(path, text, this.data.get(path)?.entry, modifiedAt);
  }
}
