import type { IDBPDatabase } from "idb";
import {
  dump,
  IdbBackend,
  MemoryBackend,
  openDatabase,
  STORES,
  type Change,
  type Encrypted,
  type Schema,
  type StoreName,
} from "./backend";
import { decryptWith, encryptWith, newVaultKey, Store } from "./storage";

/**
 * How this browser keeps notes:
 * - `plain`: IndexedDB, readable by anyone with access to the browser profile.
 * - `locked`: IndexedDB, encrypted with a key derived from a passphrase; plaintext lives in memory while unlocked.
 * - `ephemeral`: memory only; nothing is written to disk and everything is gone when the tab closes.
 */
export type Mode = "plain" | "locked" | "ephemeral";
export interface Security {
  mode: Mode;
  kdf?: { iterations: number; salt: Uint8Array<ArrayBuffer> };
  /** The random root secret, encrypted with the passphrase key. */
  root?: Encrypted;
}
export interface Keys {
  /** Encrypts sealed records. */
  data: CryptoKey;
  /** Derives opaque record ids, so paths are not visible on disk. */
  ids: CryptoKey;
  /** Encrypts provider credentials inside the working set. */
  vault: CryptoKey;
}
/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. */
export const ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;
const SESSION_LOCK = "marknotes:session";
const ROOT_AAD = new TextEncoder().encode("marknotes:root:1");
const utf8 = new TextEncoder();

export function validatePassphrase(passphrase: string): void {
  if ([...passphrase].length < MIN_PASSPHRASE)
    throw new Error(
      `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`,
    );
}

async function passphraseKey(
  passphrase: string,
  kdf: NonNullable<Security["kdf"]>,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8.encode(passphrase.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: kdf.salt,
      iterations: kdf.iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveKeys(root: Uint8Array<ArrayBuffer>): Promise<Keys> {
  const base = await crypto.subtle.importKey("raw", root, "HKDF", false, [
    "deriveKey",
  ]);
  root.fill(0);
  const derive = (
    info: string,
    algorithm: AesKeyGenParams | HmacKeyGenParams,
    usages: KeyUsage[],
  ) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: utf8.encode(info),
      },
      base,
      algorithm,
      false,
      usages,
    );
  const aes = { name: "AES-GCM", length: 256 } as const;
  return {
    data: await derive("marknotes:data", aes, ["encrypt", "decrypt"]),
    ids: await derive(
      "marknotes:ids",
      { name: "HMAC", hash: "SHA-256", length: 256 },
      ["sign"],
    ),
    vault: await derive("marknotes:vault", aes, ["encrypt", "decrypt"]),
  };
}

async function sealRoot(
  root: Uint8Array<ArrayBuffer>,
  passphrase: string,
  iterations: number,
): Promise<Security> {
  const kdf = {
    iterations,
    salt: crypto.getRandomValues(new Uint8Array(16)),
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ROOT_AAD },
    await passphraseKey(passphrase, kdf),
    root,
  );
  return { mode: "locked", kdf, root: { iv, bytes } };
}

/** Creates a new passphrase lock with a fresh random root secret. */
export async function createLock(
  passphrase: string,
  iterations = ITERATIONS,
): Promise<{ security: Security; keys: Keys }> {
  validatePassphrase(passphrase);
  const root = crypto.getRandomValues(new Uint8Array(32));
  const security = await sealRoot(root, passphrase, iterations);
  return { security, keys: await deriveKeys(root) };
}

async function openRoot(
  security: Security,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (security.mode !== "locked" || !security.kdf || !security.root)
    throw new Error("This browser is not locked with a passphrase.");
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: security.root.iv,
          additionalData: ROOT_AAD,
        },
        await passphraseKey(passphrase, security.kdf),
        security.root.bytes,
      ),
    );
  } catch {
    throw new Error("Wrong passphrase.");
  }
}

export async function unlockKeys(
  security: Security,
  passphrase: string,
): Promise<Keys> {
  return deriveKeys(await openRoot(security, passphrase));
}

/** Re-encrypts the root secret only; sealed records stay as they are. */
export async function rekey(
  security: Security,
  current: string,
  next: string,
): Promise<Security> {
  validatePassphrase(next);
  const root = await openRoot(security, current);
  const sealed = await sealRoot(
    root,
    next,
    security.kdf?.iterations ?? ITERATIONS,
  );
  root.fill(0);
  return sealed;
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** JSON with tagged binary values (attachments, encrypted credentials). */
export function encode(value: unknown): Uint8Array<ArrayBuffer> {
  return utf8.encode(
    JSON.stringify(value, function (this: unknown, key: string, v: unknown) {
      const raw = (this as Record<string, unknown>)[key];
      if (raw instanceof Uint8Array) return { $u8: toBase64(raw) };
      if (raw instanceof ArrayBuffer)
        return { $ab: toBase64(new Uint8Array(raw)) };
      if (typeof CryptoKey !== "undefined" && raw instanceof CryptoKey)
        throw new Error("Crypto keys cannot be sealed.");
      return v;
    }),
  );
}
export function decode(bytes: ArrayBuffer): unknown {
  return JSON.parse(new TextDecoder().decode(bytes), (_k, v: unknown) => {
    if (v && typeof v === "object") {
      const tagged = v as { $u8?: string; $ab?: string };
      if (typeof tagged.$u8 === "string") return fromBase64(tagged.$u8);
      if (typeof tagged.$ab === "string") return fromBase64(tagged.$ab).buffer;
    }
    return v;
  });
}

/** The encrypted on-disk mirror of a locked browser's working set. */
export class Sealer {
  constructor(
    private db: IDBPDatabase<Schema>,
    private keys: Keys,
  ) {}
  private async id(store: StoreName, key: string): Promise<string> {
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        this.keys.ids,
        utf8.encode(`${store}\u0000${key}`),
      ),
    );
    return toBase64(mac)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  /** Encrypts changes into sealed records (`value` undefined = delete). */
  async seal(changes: Change[]): Promise<{ id: string; value?: Encrypted }[]> {
    const out: { id: string; value?: Encrypted }[] = [];
    for (const c of changes) {
      const id = await this.id(c.store, c.key);
      if (c.deleted) {
        out.push({ id });
        continue;
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: utf8.encode(id) },
        this.keys.data,
        encode({ s: c.store, k: c.key, v: c.value }),
      );
      out.push({ id, value: { iv, bytes } });
    }
    return out;
  }
  async persist(changes: Change[]): Promise<void> {
    const sealed = await this.seal(changes);
    const tx = this.db.transaction("sealed", "readwrite");
    for (const { id, value } of sealed)
      if (value) void tx.store.put(value, id);
      else void tx.store.delete(id);
    await tx.done;
  }
  async load(): Promise<Change[]> {
    const tx = this.db.transaction("sealed", "readonly");
    const [ids, values] = await Promise.all([
      tx.store.getAllKeys(),
      tx.store.getAll(),
    ]);
    await tx.done;
    const out: Change[] = [];
    for (const [i, id] of ids.entries()) {
      const record = values[i]!;
      let plain: ArrayBuffer;
      try {
        plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: record.iv, additionalData: utf8.encode(id) },
          this.keys.data,
          record.bytes,
        );
      } catch {
        throw new Error(
          "Encrypted notes in this browser are damaged or were tampered with.",
        );
      }
      const { s, k, v } = decode(plain) as {
        s: StoreName;
        k: string;
        v: unknown;
      };
      if (!STORES.includes(s) || (await this.id(s, k)) !== id)
        throw new Error(
          "Encrypted notes in this browser are damaged or were tampered with.",
        );
      out.push({ store: s, key: k, value: v });
    }
    return out;
  }
}

/** Holds the per-origin session lock: memory-backed modes need a single tab. */
function holdSession(
  mode: "shared" | "exclusive",
): Promise<(() => void) | null> {
  if (!navigator.locks)
    return Promise.reject(
      new Error(
        "This browser needs Web Locks support for safe editing and sync.",
      ),
    );
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(SESSION_LOCK, { mode, ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(reject);
  });
}
async function otherTabs(): Promise<boolean> {
  const state = await navigator.locks.query();
  return (
    (state.held ?? []).filter((l) => l.name === SESSION_LOCK).length > 1 ||
    (state.pending ?? []).some((l) => l.name === SESSION_LOCK)
  );
}

const CREDENTIALS = /:credentials$/;
const DEVICE_LOCAL = new Set(["vault-key"]);

/** One tab's view of this browser's storage: mode, unlock state and the notes `Store`. */
export class Session {
  private keys?: Keys;
  private working?: Store;
  private constructor(
    readonly db: IDBPDatabase<Schema>,
    readonly name: string,
    public security: Security,
    private release: () => void,
    readonly iterations: number,
  ) {}
  static async open(
    name = "marknotes",
    iterations = ITERATIONS,
  ): Promise<Session> {
    const db = await openDatabase(name);
    try {
      const security = ((await db.get("meta", "security")) as
        Security | undefined) ?? { mode: "plain" };
      const release = await holdSession(
        security.mode === "plain" ? "shared" : "exclusive",
      );
      if (!release)
        throw new Error(
          security.mode === "plain"
            ? "MarkNotes is open in another tab with locked or memory-only storage. Close it, then reload."
            : "MarkNotes is already open in another tab. Close it, then reload.",
        );
      return new Session(db, name, security, release, iterations);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  get mode(): Mode {
    return this.security.mode;
  }
  get locked(): boolean {
    return this.mode === "locked" && !this.working;
  }
  /** The working notes store. For a locked browser, call `unlock` first. */
  async store(): Promise<Store> {
    if (this.working) return this.working;
    if (this.mode === "locked")
      throw new Error("Unlock MarkNotes with your passphrase first.");
    this.working =
      this.mode === "plain"
        ? new Store(new IdbBackend(this.db))
        : new Store(new MemoryBackend(), await newVaultKey());
    return this.working;
  }
  async unlock(passphrase: string): Promise<Store> {
    const keys = await unlockKeys(this.security, passphrase);
    const sealer = new Sealer(this.db, keys);
    const backend = new MemoryBackend((changes) => sealer.persist(changes));
    backend.load(await sealer.load());
    this.keys = keys;
    this.working = new Store(backend, keys.vault);
    return this.working;
  }
  /** Confirms the passphrase of an unlocked browser (before removing or changing it). */
  async verify(passphrase: string): Promise<void> {
    await openRoot(this.security, passphrase);
  }
  async changePassphrase(current: string, next: string): Promise<void> {
    const security = await rekey(this.security, current, next);
    await this.db.put("meta", security, "security");
    this.security = security;
  }
  /**
   * Moves every note, image, sync record and credential into `target` storage, removing the old copy in the same
   * IndexedDB transaction. Switching to `ephemeral` drops all local data (drives keep theirs). Reload afterwards.
   */
  async switchTo(target: Mode, passphrase?: string): Promise<void> {
    if (await otherTabs())
      throw new Error("Close other MarkNotes tabs before changing storage.");
    if (target === this.mode) return;
    const source = await this.store();
    const entries = target === "ephemeral" ? [] : await this.portable(source);
    let security: Security = { mode: target };
    let writes: {
      sealed?: { id: string; value?: Encrypted }[];
      plain?: Change[];
    };
    if (target === "locked") {
      if (!passphrase) throw new Error("Choose a passphrase.");
      const lock = await createLock(passphrase, this.iterations);
      security = lock.security;
      const reencrypted = await this.withCredentials(entries, lock.keys.vault);
      writes = {
        sealed: await new Sealer(this.db, lock.keys).seal(reencrypted),
      };
    } else if (target === "plain") {
      const key = await newVaultKey();
      writes = {
        plain: [
          ...(await this.withCredentials(entries, key)),
          { store: "values", key: "vault-key", value: key },
        ],
      };
    } else writes = {};
    const tx = this.db.transaction([...STORES, "sealed", "meta"], "readwrite");
    await Promise.all([
      ...STORES.map((s) => tx.objectStore(s).clear()),
      tx.objectStore("sealed").clear(),
    ]);
    for (const { id, value } of writes.sealed ?? [])
      void tx.objectStore("sealed").put(value!, id);
    for (const c of writes.plain ?? [])
      if (c.store === "values")
        void tx.objectStore("values").put(c.value, c.key);
      else void tx.objectStore(c.store as "notes").put(c.value as never);
    void tx.objectStore("meta").put(security, "security");
    await tx.done;
    this.security = security;
  }
  /** All records except device-local keys, with credentials decrypted for re-encryption. */
  private async portable(source: Store): Promise<Change[]> {
    const vault =
      source.vaultKey ?? (await source.value<CryptoKey>("vault-key"));
    const out: Change[] = [];
    for (const c of await dump(source.backend)) {
      if (c.store === "values" && DEVICE_LOCAL.has(c.key)) continue;
      if (c.store === "values" && CREDENTIALS.test(c.key)) {
        if (!vault) continue;
        try {
          out.push({
            ...c,
            value: {
              plain: await decryptWith(vault, c.value as Encrypted),
            },
          });
        } catch {
          // Unreadable credentials: the account must be reconnected anyway.
        }
        continue;
      }
      out.push(c);
    }
    return out;
  }
  private async withCredentials(
    entries: Change[],
    key: CryptoKey,
  ): Promise<Change[]> {
    const out: Change[] = [];
    for (const c of entries)
      out.push(
        c.store === "values" && CREDENTIALS.test(c.key)
          ? {
              ...c,
              value: await encryptWith(
                key,
                (c.value as { plain: unknown }).plain,
              ),
            }
          : c,
      );
    return out;
  }
  close(): void {
    this.working?.close();
    this.db.close();
    this.release();
  }
  /**
   * Deletes everything MarkNotes stored in this browser: notes, images, sync state, credentials, passphrase data
   * and settings. Drives are not touched. Other tabs are closed by the deletion. Reload afterwards.
   */
  async forget(): Promise<void> {
    this.close();
    await forgetDevice(this.name);
  }
}

export async function forgetDevice(name = "marknotes"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Delete failed."));
  });
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Storage may be unavailable (private mode); nothing to clear.
  }
  if (typeof caches !== "undefined")
    for (const key of await caches.keys()) await caches.delete(key);
}
