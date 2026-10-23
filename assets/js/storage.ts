import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { inAttachments } from "./attachments";
import { idsToAssign, newId, newNoteText, withId } from "./notemeta";

export interface Note {
  path: string;
  folder: boolean;
  text: string;
  revision: string;
  /** Epoch ms of the last content change; absent on notes stored before newest-wins sync. */
  modifiedAt?: number;
}
export interface Account {
  id: string;
  provider: "dropbox" | "onedrive";
  label: string;
  folder: string;
  subject: string;
}
export interface RecordState {
  path: string;
  folder: boolean;
  remoteId: string;
  version: string;
  hash: string;
  syncedAt: number;
}
/** An immutable binary file under `attachments/`, named by the SHA-256 of its bytes. */
export interface Attachment {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  modifiedAt: number;
}
interface Schema extends DBSchema {
  notes: { key: string; value: Note };
  attachments: { key: string; value: Attachment };
  values: { key: string; value: unknown };
}

export function validateName(name: string): void {
  if (
    !name.trim() ||
    name !== name.trim() ||
    /^[.]/.test(name) ||
    /[/\\]/.test(name)
  )
    throw new Error(
      "Names cannot be blank, start with a dot, contain slashes or surrounding spaces.",
    );
}
export function validatePath(path: string): void {
  if (!path || path.split("/").some((part) => !part))
    throw new Error("Invalid relative path.");
  path.split("/").forEach(validateName);
}
export const parent = (path: string): string =>
  path.split("/").slice(0, -1).join("/");
export const join = (a: string, b: string): string => (a ? `${a}/${b}` : b);
export const inside = (folder: string, path: string): boolean =>
  path.startsWith(`${folder}/`);
export const isNote = (path: string): boolean => /\.md$/i.test(path);
export function syncable(path: string): boolean {
  try {
    validatePath(path);
    return true;
  } catch {
    return false;
  }
}

function reserved(path: string): void {
  if (inAttachments(path))
    throw new Error("The attachments folder is reserved for images.");
}

export class Store {
  constructor(private db: IDBPDatabase<Schema>) {}
  static async open(name = "marknotes"): Promise<Store> {
    return new Promise<Store>((resolve, reject) => {
      let blocked = false;
      void openDB<Schema>(name, 2, {
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            db.createObjectStore("notes", { keyPath: "path" });
            db.createObjectStore("values");
          }
          if (oldVersion < 2)
            db.createObjectStore("attachments", { keyPath: "path" });
        },
        blocked() {
          blocked = true;
          reject(
            new Error(
              "Close other MarkNotes tabs, then reload to upgrade storage.",
            ),
          );
        },
        blocking(_a, _b, event) {
          (event.target as IDBDatabase).close();
          window.dispatchEvent(
            new CustomEvent("marknotes:error", {
              detail:
                "Storage changed in another tab. Copy any unsaved text and reload.",
            }),
          );
        },
      }).then((db) => {
        if (blocked) db.close();
        else resolve(new Store(db));
      }, reject);
    });
  }
  close(): void {
    this.db.close();
  }
  async list(): Promise<Note[]> {
    return (await this.db.getAll("notes")).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }
  async note(path: string): Promise<Note | undefined> {
    return this.db.get("notes", path);
  }
  async value<T>(key: string): Promise<T | undefined> {
    return (await this.db.get("values", key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.db.put("values", value, key);
  }
  async remove(key: string): Promise<void> {
    await this.db.delete("values", key);
  }
  async deviceId(): Promise<string> {
    const tx = this.db.transaction("values", "readwrite");
    let id = await tx.store.get("device");
    if (typeof id !== "string") {
      id = crypto.randomUUID();
      await tx.store.put(id, "device");
    }
    await tx.done;
    return String(id);
  }
  async write(
    path: string,
    text: string,
    expectedRevision?: string,
    modifiedAt = Date.now(),
  ): Promise<Note> {
    validatePath(path);
    if (!isNote(path)) throw new Error("Notes must have a .md extension.");
    const tx = this.db.transaction("notes", "readwrite");
    const old = await tx.store.get(path);
    if (
      old?.folder ||
      (expectedRevision !== undefined && old?.revision !== expectedRevision)
    ) {
      await tx.done;
      throw new Error(
        "This note changed in another tab or sync. Your unsaved text is still in the editor; copy it before reopening.",
      );
    }
    const parts = path.split("/");
    const missing: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const existing = await tx.store.get(p);
      if (existing && !existing.folder) {
        await tx.done;
        throw new Error(`A note blocks folder ${p}`);
      }
      if (!existing) missing.push(p);
    }
    for (const p of missing)
      await tx.store.put({
        path: p,
        folder: true,
        text: "",
        revision: crypto.randomUUID(),
      });
    const note = {
      path,
      folder: false,
      text,
      revision: crypto.randomUUID(),
      modifiedAt,
    };
    await tx.store.put(note);
    await tx.done;
    return note;
  }
  async create(path: string, folder: boolean, text?: string): Promise<void> {
    validatePath(path);
    reserved(path);
    if (await this.note(path)) throw new Error("That name already exists.");
    if (!folder) {
      await this.write(path, text ?? newNoteText());
      return;
    }
    const p = parent(path);
    if (p && !(await this.note(p))?.folder)
      throw new Error("Parent folder does not exist.");
    await this.db.add("notes", {
      path,
      folder: true,
      text: "",
      revision: crypto.randomUUID(),
    });
  }
  async delete(path: string): Promise<void> {
    const tx = this.db.transaction("notes", "readwrite");
    for (const key of await tx.store.getAllKeys())
      if (key === path || inside(path, key)) await tx.store.delete(key);
    await tx.done;
  }
  async move(from: string, to: string): Promise<void> {
    validatePath(to);
    reserved(to);
    if (from === to) return;
    if (inside(from, to))
      throw new Error("Cannot move a folder inside itself.");
    const tx = this.db.transaction("notes", "readwrite");
    const all = await tx.store.getAll();
    const source = all.find((n) => n.path === from);
    if (!source) throw new Error("Item no longer exists.");
    if (!source.folder && !isNote(to))
      throw new Error("Notes must have a .md extension.");
    if (all.some((n) => n.path === to))
      throw new Error("Destination already exists.");
    const p = parent(to);
    if (p && !all.some((n) => n.path === p && n.folder))
      throw new Error("Destination folder does not exist.");
    const now = Date.now();
    for (const note of all.filter(
      (n) => n.path === from || inside(from, n.path),
    )) {
      await tx.store.delete(note.path);
      await tx.store.add({
        ...note,
        path: to + note.path.slice(from.length),
        revision: crypto.randomUUID(),
        modifiedAt: now,
      });
    }
    await tx.done;
  }
  /**
   * Gives a fresh id to notes in `scope` (all notes when omitted) that lack one or duplicate
   * the id of an earlier note by sorted path. Returns the paths that were rewritten.
   */
  async assignIds(scope?: Iterable<string>): Promise<string[]> {
    const tx = this.db.transaction("notes", "readwrite");
    const notes = (await tx.store.getAll()).filter((n) => !n.folder);
    const wanted = scope ? new Set(scope) : undefined;
    const changed: string[] = [];
    const now = Date.now();
    for (const path of idsToAssign(notes)) {
      if (wanted && !wanted.has(path)) continue;
      const note = notes.find((n) => n.path === path)!;
      await tx.store.put({
        ...note,
        text: withId(note.text, newId()),
        revision: crypto.randomUUID(),
        modifiedAt: now,
      });
      changed.push(path);
    }
    await tx.done;
    return changed;
  }
  async attachments(): Promise<Attachment[]> {
    return this.db.getAll("attachments");
  }
  async attachmentPaths(): Promise<string[]> {
    return this.db.getAllKeys("attachments");
  }
  async attachment(path: string): Promise<Attachment | undefined> {
    return this.db.get("attachments", path);
  }
  async putAttachment(
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    modifiedAt = Date.now(),
  ): Promise<void> {
    await this.db.put("attachments", { path, bytes, modifiedAt });
  }
  async deleteAttachment(path: string): Promise<void> {
    await this.db.delete("attachments", path);
  }
  /** The text of a note the last time it was synced with a drive: the base of later three-way merges. */
  async base(account: string, path: string): Promise<string | undefined> {
    return this.value<string>(`${account}:base:${path}`);
  }
  async putBase(account: string, path: string, text: string): Promise<void> {
    await this.put(`${account}:base:${path}`, text);
  }
  /** Drops the base copies of `path` and everything inside it. */
  async deleteBase(account: string, path: string): Promise<void> {
    const key = `${account}:base:${path}`;
    const tx = this.db.transaction("values", "readwrite");
    await tx.store.delete(key);
    await tx.store.delete(IDBKeyRange.bound(`${key}/`, `${key}/\uffff`));
    await tx.done;
  }
  async accounts(): Promise<Account[]> {
    return (await this.value<Account[]>("accounts")) ?? [];
  }
  async saveAccount(account: Account): Promise<void> {
    await this.put("accounts", [
      ...(await this.accounts()).filter((a) => a.id !== account.id),
      account,
    ]);
  }
  async forgetAccount(id: string): Promise<void> {
    const tx = this.db.transaction("values", "readwrite");
    const accounts = (await tx.store.get("accounts")) as Account[] | undefined;
    await tx.store.put(
      (accounts ?? []).filter((a) => a.id !== id),
      "accounts",
    );
    for (const key of await tx.store.getAllKeys())
      if (key.startsWith(`${id}:`)) await tx.store.delete(key);
    await tx.done;
  }
}

export async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser needs Web Locks support for safe editing and sync.",
    );
  return navigator.locks.request("marknotes:tree", work);
}

interface Encrypted {
  iv: Uint8Array<ArrayBuffer>;
  bytes: ArrayBuffer;
}
export class Vault {
  constructor(private store: Store) {}
  private async key(): Promise<CryptoKey> {
    let key = await this.store.value<CryptoKey>("vault-key");
    if (!key) {
      key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await this.store.put("vault-key", key);
    }
    return key;
  }
  async save(id: string, value: unknown): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.key(),
      new TextEncoder().encode(JSON.stringify(value)),
    );
    await this.store.put(`${id}:credentials`, { iv, bytes });
  }
  async load<T>(id: string): Promise<T | undefined> {
    const data = await this.store.value<Encrypted>(`${id}:credentials`);
    if (!data) return undefined;
    const key = await this.store.value<CryptoKey>("vault-key");
    if (!key)
      throw new Error("Credential key is missing. Reconnect this account.");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.iv },
      key,
      data.bytes,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  }
}
