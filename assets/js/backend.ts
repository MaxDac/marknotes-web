import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Attachment, Note } from "./storage";

/** An AES-GCM ciphertext. */
export interface Encrypted {
  iv: Uint8Array<ArrayBuffer>;
  bytes: ArrayBuffer;
}
export interface Schema extends DBSchema {
  notes: { key: string; value: Note };
  attachments: { key: string; value: Attachment };
  values: { key: string; value: unknown };
  /** Encrypted records of a passphrase-locked browser, keyed by an opaque HMAC id. */
  sealed: { key: string; value: Encrypted };
  /** Storage mode and passphrase parameters; never holds note data. */
  meta: { key: string; value: unknown };
}
export type StoreName = "notes" | "attachments" | "values";
export const STORES: StoreName[] = ["notes", "attachments", "values"];
export interface Records {
  notes: Note;
  attachments: Attachment;
  values: unknown;
}
/** A record write (`value` set) or deletion (`deleted`). */
export interface Change {
  store: StoreName;
  key: string;
  value?: unknown;
  deleted?: boolean;
}
export interface Tx {
  get<S extends StoreName>(
    store: S,
    key: string,
  ): Promise<Records[S] | undefined>;
  getAll<S extends StoreName>(store: S): Promise<Records[S][]>;
  keys(store: StoreName): Promise<string[]>;
  /** `key` is only for `values`; notes and attachments are keyed by `path`. */
  put<S extends StoreName>(
    store: S,
    value: Records[S],
    key?: string,
  ): Promise<void>;
  /** Like `put`, but fails if the key exists. */
  add<S extends StoreName>(
    store: S,
    value: Records[S],
    key?: string,
  ): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}
/** Where the working notes tree lives: IndexedDB, or memory only. */
export interface Backend {
  tx<T>(
    stores: StoreName[],
    mode: IDBTransactionMode,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  close(): void;
}

export const DB_VERSION = 3;
export function openDatabase(
  name = "marknotes",
): Promise<IDBPDatabase<Schema>> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    void openDB<Schema>(name, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("notes", { keyPath: "path" });
          db.createObjectStore("values");
        }
        if (oldVersion < 2)
          db.createObjectStore("attachments", { keyPath: "path" });
        if (oldVersion < 3) {
          db.createObjectStore("sealed");
          db.createObjectStore("meta");
        }
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
      else resolve(db);
    }, reject);
  });
}

const keyOf = (store: StoreName, value: unknown, key?: string): string =>
  store === "values" ? key! : (value as { path: string }).path;

export class IdbBackend implements Backend {
  constructor(readonly db: IDBPDatabase<Schema>) {}
  async tx<T>(
    stores: StoreName[],
    mode: IDBTransactionMode,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const t = this.db.transaction(stores, mode);
    // A union of store names defeats idb's per-store typing; the Tx signature restores it.
    const os = (s: StoreName) => t.objectStore(s as "values");
    const tx: Tx = {
      get: async (s, k) => (await os(s).get(k)) as never,
      getAll: async (s) => (await os(s).getAll()) as never,
      keys: (s) => os(s).getAllKeys(),
      put: async (s, v, k) => {
        await (s === "values" ? os(s).put!(v, k) : os(s).put!(v));
      },
      add: async (s, v, k) => {
        await (s === "values" ? os(s).add!(v, k) : os(s).add!(v));
      },
      delete: (s, k) => os(s).delete!(k),
    };
    try {
      const result = await work(tx);
      await t.done;
      return result;
    } catch (error) {
      try {
        t.abort();
      } catch {
        // Already finished.
      }
      await t.done.catch(() => {});
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}

/**
 * Keeps the notes tree in memory only. Write transactions are serialised and atomic: changes are staged, handed to
 * `persist` (the encrypted mirror of a locked browser) and applied only once it succeeds.
 */
export class MemoryBackend implements Backend {
  private data: Record<StoreName, Map<string, unknown>> = {
    notes: new Map(),
    attachments: new Map(),
    values: new Map(),
  };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private persist?: (changes: Change[]) => Promise<void>) {}
  load(changes: Iterable<Change>): void {
    for (const c of changes)
      if (c.deleted) this.data[c.store].delete(c.key);
      else this.data[c.store].set(c.key, structuredClone(c.value));
  }
  tx<T>(
    _stores: StoreName[],
    mode: IDBTransactionMode,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (mode === "readonly") return work(this.view(undefined));
    const run = this.queue.then(() => this.write(work));
    this.queue = run.catch(() => {});
    return run;
  }
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const staged = new Map<string, Change>();
    const result = await work(this.view(staged));
    const changes = [...staged.values()];
    if (changes.length) {
      await this.persist?.(changes);
      this.load(changes);
    }
    return result;
  }
  private view(staged: Map<string, Change> | undefined): Tx {
    const id = (s: StoreName, k: string) => `${s}\u0000${k}`;
    const read = (s: StoreName, k: string): unknown => {
      const c = staged?.get(id(s, k));
      return c ? (c.deleted ? undefined : c.value) : this.data[s].get(k);
    };
    const keys = (s: StoreName): string[] => {
      const all = new Set(this.data[s].keys());
      for (const c of staged?.values() ?? [])
        if (c.store === s) {
          if (c.deleted) all.delete(c.key);
          else all.add(c.key);
        }
      return [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    };
    const stage = (change: Change) => {
      if (!staged) throw new Error("Read-only transaction.");
      staged.set(id(change.store, change.key), change);
    };
    const clone = <T>(value: T): T =>
      value === undefined ? value : structuredClone(value);
    return {
      get: async (s, k) => clone(read(s, k)) as never,
      getAll: async (s) => keys(s).map((k) => clone(read(s, k))) as never,
      keys: async (s) => keys(s),
      put: async (s, v, k) => {
        const key = keyOf(s, v, k);
        stage({ store: s, key, value: structuredClone(v) });
      },
      add: async (s, v, k) => {
        const key = keyOf(s, v, k);
        if (read(s, key) !== undefined)
          throw new DOMException("Key already exists.", "ConstraintError");
        stage({ store: s, key, value: structuredClone(v) });
      },
      delete: async (s, k) => stage({ store: s, key: k, deleted: true }),
    };
  }
  close(): void {}
}

/** Every record of a backend, as writes. */
export async function dump(backend: Backend): Promise<Change[]> {
  return backend.tx(STORES, "readonly", async (tx) => {
    const out: Change[] = [];
    for (const store of STORES)
      for (const key of await tx.keys(store))
        out.push({ store, key, value: await tx.get(store, key) });
    return out;
  });
}
