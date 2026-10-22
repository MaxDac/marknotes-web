import type { Entry, Remote } from "../js/sync";
export class FakeDrive implements Remote {
  data = new Map<string, { entry: Entry; text: string }>();
  manifest: string | null = null;
  writes = 0;
  revision = 0;
  fail = false;
  async snapshot(): Promise<Entry[]> {
    if (this.fail) throw new Error("Unavailable");
    return [...this.data.values()].map((n) => ({ ...n.entry }));
  }
  async download(entry: Entry): Promise<string> {
    return this.data.get(entry.path)!.text;
  }
  async upload(
    path: string,
    text: string,
    previous?: Entry,
    modifiedAt = Date.now(),
  ): Promise<Entry> {
    const old = this.data.get(path);
    if (old && old.entry.version !== previous?.version)
      throw new Error("Revision conflict");
    const entry = {
      path,
      id: old?.entry.id ?? crypto.randomUUID(),
      folder: false,
      version: String(++this.revision),
      modifiedAt,
    };
    this.data.set(path, { entry, text });
    return entry;
  }
  async mkdir(path: string): Promise<Entry> {
    const old = this.data.get(path);
    if (old) return old.entry;
    const entry = { path, id: crypto.randomUUID(), folder: true, version: "" };
    this.data.set(path, { entry, text: "" });
    return entry;
  }
  async delete(entry: Entry): Promise<void> {
    for (const path of this.data.keys())
      if (path === entry.path || path.startsWith(`${entry.path}/`))
        this.data.delete(path);
  }
  async readManifest(): Promise<string | null> {
    return this.manifest;
  }
  async writeManifest(text: string): Promise<void> {
    this.manifest = text;
    this.writes++;
  }
  async edit(path: string, text: string, modifiedAt?: number): Promise<void> {
    await this.upload(path, text, this.data.get(path)?.entry, modifiedAt);
  }
}
