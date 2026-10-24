import {
  IdbBackend,
  openDatabase,
  type Backend,
  type Encrypted,
  type StoreName,
  type Tx,
} from "./backend";
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
  /**
   * @param vaultKey encrypts provider credentials when the tree is memory-backed (locked or memory-only browsers);
   * otherwise a non-extractable key is generated and kept in IndexedDB.
   */
  constructor(
    readonly backend: Backend,
    readonly vaultKey?: CryptoKey,
  ) {}
  static async open(name = "marknotes"): Promise<Store> {
    return new Store(new IdbBackend(await openDatabase(name)));
  }
  close(): void {
    this.backend.close();
  }
  private read<T>(
    stores: StoreName[],
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.backend.tx(stores, "readonly", work);
  }
  private change<T>(
    stores: StoreName[],
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.backend.tx(stores, "readwrite", work);
  }
  async list(): Promise<Note[]> {
    return (await this.read(["notes"], (tx) => tx.getAll("notes"))).sort(
      (a, b) => a.path.localeCompare(b.path),
    );
  }
  async note(path: string): Promise<Note | undefined> {
    return this.read(["notes"], (tx) => tx.get("notes", path));
  }
  async value<T>(key: string): Promise<T | undefined> {
    return (await this.read(["values"], (tx) => tx.get("values", key))) as
      T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.change(["values"], (tx) => tx.put("values", value, key));
  }
  async remove(key: string): Promise<void> {
    await this.change(["values"], (tx) => tx.delete("values", key));
  }
  async deviceId(): Promise<string> {
    return this.change(["values"], async (tx) => {
      let id = await tx.get("values", "device");
      if (typeof id !== "string") {
        id = crypto.randomUUID();
        await tx.put("values", id, "device");
      }
      return String(id);
    });
  }
  async write(
    path: string,
    text: string,
    expectedRevision?: string,
    modifiedAt = Date.now(),
  ): Promise<Note> {
    validatePath(path);
    if (!isNote(path)) throw new Error("Notes must have a .md extension.");
    return this.change(["notes"], async (tx) => {
      const old = await tx.get("notes", path);
      if (
        old?.folder ||
        (expectedRevision !== undefined && old?.revision !== expectedRevision)
      )
        throw new Error(
          "This note changed in another tab or sync. Your unsaved text is still in the editor; copy it before reopening.",
        );
      const parts = path.split("/");
      const missing: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        const existing = await tx.get("notes", p);
        if (existing && !existing.folder)
          throw new Error(`A note blocks folder ${p}`);
        if (!existing) missing.push(p);
      }
      for (const p of missing)
        await tx.put("notes", {
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
      await tx.put("notes", note);
      return note;
    });
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
    await this.change(["notes"], (tx) =>
      tx.add("notes", {
        path,
        folder: true,
        text: "",
        revision: crypto.randomUUID(),
      }),
    );
  }
  async delete(path: string): Promise<void> {
    await this.change(["notes"], async (tx) => {
      for (const key of await tx.keys("notes"))
        if (key === path || inside(path, key)) await tx.delete("notes", key);
    });
  }
  async move(from: string, to: string): Promise<void> {
    validatePath(to);
    reserved(to);
    if (from === to) return;
    if (inside(from, to))
      throw new Error("Cannot move a folder inside itself.");
    await this.change(["notes"], async (tx) => {
      const all = await tx.getAll("notes");
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
        await tx.delete("notes", note.path);
        await tx.add("notes", {
          ...note,
          path: to + note.path.slice(from.length),
          revision: crypto.randomUUID(),
          modifiedAt: now,
        });
      }
    });
  }
  /**
   * Gives a fresh id to notes in `scope` (all notes when omitted) that lack one or duplicate
   * the id of an earlier note by sorted path. Returns the paths that were rewritten.
   */
  async assignIds(scope?: Iterable<string>): Promise<string[]> {
    return this.change(["notes"], async (tx) => {
      const notes = (await tx.getAll("notes")).filter((n) => !n.folder);
      const wanted = scope ? new Set(scope) : undefined;
      const changed: string[] = [];
      const now = Date.now();
      for (const path of idsToAssign(notes)) {
        if (wanted && !wanted.has(path)) continue;
        const note = notes.find((n) => n.path === path)!;
        await tx.put("notes", {
          ...note,
          text: withId(note.text, newId()),
          revision: crypto.randomUUID(),
          modifiedAt: now,
        });
        changed.push(path);
      }
      return changed;
    });
  }
  async attachments(): Promise<Attachment[]> {
    return this.read(["attachments"], (tx) => tx.getAll("attachments"));
  }
  async attachmentPaths(): Promise<string[]> {
    return this.read(["attachments"], (tx) => tx.keys("attachments"));
  }
  async attachment(path: string): Promise<Attachment | undefined> {
    return this.read(["attachments"], (tx) => tx.get("attachments", path));
  }
  async putAttachment(
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    modifiedAt = Date.now(),
  ): Promise<void> {
    await this.change(["attachments"], (tx) =>
      tx.put("attachments", { path, bytes, modifiedAt }),
    );
  }
  async deleteAttachment(path: string): Promise<void> {
    await this.change(["attachments"], (tx) => tx.delete("attachments", path));
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
    await this.change(["values"], async (tx) => {
      for (const k of await tx.keys("values"))
        if (k === key || k.startsWith(`${key}/`)) await tx.delete("values", k);
    });
  }
  async accounts(): Promise<Account[]> {
    return (await this.value<Account[]>("accounts")) ?? [];
  }
  async saveAccount(account: Account): Promise<void> {
    await this.change(["values"], async (tx) => {
      const accounts = (await tx.get("values", "accounts")) as
        Account[] | undefined;
      await tx.put(
        "values",
        [...(accounts ?? []).filter((a) => a.id !== account.id), account],
        "accounts",
      );
    });
  }
  async forgetAccount(id: string): Promise<void> {
    await this.change(["values"], async (tx) => {
      const accounts = (await tx.get("values", "accounts")) as
        Account[] | undefined;
      await tx.put(
        "values",
        (accounts ?? []).filter((a) => a.id !== id),
        "accounts",
      );
      for (const key of await tx.keys("values"))
        if (key.startsWith(`${id}:`)) await tx.delete("values", key);
    });
  }
}

export async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser needs Web Locks support for safe editing and sync.",
    );
  return navigator.locks.request("marknotes:tree", work);
}

export async function encryptWith(
  key: CryptoKey,
  value: unknown,
): Promise<Encrypted> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { iv, bytes };
}
export async function decryptWith<T>(
  key: CryptoKey,
  data: Encrypted,
): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: data.iv },
    key,
    data.bytes,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
export const newVaultKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]) as Promise<CryptoKey>;

export class Vault {
  constructor(private store: Store) {}
  private async key(): Promise<CryptoKey> {
    if (this.store.vaultKey) return this.store.vaultKey;
    let key = await this.store.value<CryptoKey>("vault-key");
    if (!key) {
      key = await newVaultKey();
      await this.store.put("vault-key", key);
    }
    return key;
  }
  async save(id: string, value: unknown): Promise<void> {
    await this.store.put(
      `${id}:credentials`,
      await encryptWith(await this.key(), value),
    );
  }
  async load<T>(id: string): Promise<T | undefined> {
    const data = await this.store.value<Encrypted>(`${id}:credentials`);
    if (!data) return undefined;
    const key =
      this.store.vaultKey ?? (await this.store.value<CryptoKey>("vault-key"));
    if (!key)
      throw new Error("Credential key is missing. Reconnect this account.");
    return decryptWith<T>(key, data);
  }
}
