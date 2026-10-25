import {
  IdbBackend,
  openDatabase,
  type Backend,
  type Encrypted,
  type StoreName,
  type Tx,
} from "./backend";
import {
  attachmentPath,
  inAttachments,
  mimeFor,
  referencedAttachments,
  type ProcessedImage,
} from "./attachments";
import { idsToAssign, newId, newNoteText, noteId, withId } from "./notemeta";
import { foldCase } from "@marknotes/sync";
import { Diagnostics } from "./diagnostics";

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
  localDeleted?: boolean;
  /** The folder was deleted here but kept on a drive that cannot delete empty folders safely. */
  remoteFolderPreserved?: boolean;
}
/**
 * Tells the user once to remove a folder deleted in this browser from a drive by hand. Each deletion gets a new
 * `generation`; the notice stops being `active` when the folder is revived, recreated, replaced or gone.
 */
export interface FolderNotice {
  path: string;
  remoteId: string;
  generation: string;
  acknowledged: boolean;
  active: boolean;
}
/** The drive identity of a preserved folder whose record was retired because the folder was recreated here. */
interface FolderWitness {
  path: string;
  remoteId: string;
}
const noticesKey = (account: string) => `${account}:folder-notices`;
const witnessesKey = (account: string) => `${account}:recreated-folders`;

/** Drops the sync history strictly inside `folder`: its records are returned without them. */
async function retireDescendants(
  tx: Tx,
  account: string,
  records: RecordState[],
  folder: string,
): Promise<RecordState[]> {
  const prefix = `${account}:base:`;
  for (const key of await tx.keys("values"))
    if (key.startsWith(prefix) && inside(folder, key.slice(prefix.length)))
      await tx.delete("values", key);
  return records.filter((r) => !inside(folder, r.path));
}

/**
 * Saves a drive's records with its folder notices and witnesses. A notice stays active only while its folder record
 * is still preserved with the same identity, and a witness only until the path has a record again.
 */
async function saveHistory(
  tx: Tx,
  account: string,
  records: RecordState[],
  notices?: FolderNotice[],
  witnesses?: FolderWitness[],
): Promise<void> {
  const storedNotices = (await tx.get("values", noticesKey(account))) as
    FolderNotice[] | undefined;
  const storedWitnesses = (await tx.get("values", witnessesKey(account))) as
    FolderWitness[] | undefined;
  const byPath = new Map(records.map((r) => [r.path, r]));
  const nextNotices = (notices ?? storedNotices ?? []).map((n) => {
    const r = byPath.get(n.path);
    return !n.active ||
      (r?.folder && r.remoteFolderPreserved && r.remoteId === n.remoteId)
      ? n
      : { ...n, active: false };
  });
  const nextWitnesses = (witnesses ?? storedWitnesses ?? []).filter(
    (w) => !byPath.has(w.path),
  );
  await tx.put("values", records, `${account}:records`);
  if (
    notices ||
    JSON.stringify(nextNotices) !== JSON.stringify(storedNotices ?? [])
  )
    await tx.put("values", nextNotices, noticesKey(account));
  if (
    witnesses ||
    JSON.stringify(nextWitnesses) !== JSON.stringify(storedWitnesses ?? [])
  )
    await tx.put("values", nextWitnesses, witnessesKey(account));
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
  readonly diagnostics: Diagnostics;
  /**
   * @param vaultKey encrypts provider credentials when the tree is memory-backed (locked or memory-only browsers);
   * otherwise a non-extractable key is generated and kept in IndexedDB.
   */
  constructor(
    readonly backend: Backend,
    readonly vaultKey?: CryptoKey,
  ) {
    this.diagnostics = new Diagnostics(backend);
  }
  static async open(name = "marknotes"): Promise<Store> {
    return new Store(new IdbBackend(await openDatabase(name)));
  }
  close(): void {
    this.diagnostics.close();
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
    expectedRevision?: string | null,
    modifiedAt = Date.now(),
  ): Promise<Note> {
    validatePath(path);
    if (!isNote(path)) throw new Error("Notes must have a .md extension.");
    return this.change(["notes"], async (tx) => {
      const old = await tx.get("notes", path);
      if (
        old?.folder ||
        (expectedRevision !== undefined &&
          (old?.revision ?? null) !== expectedRevision)
      )
        throw new Error(
          "This note changed in another tab or sync. Your unsaved text is still in the editor; copy it before reopening.",
        );
      const parts = path.split("/");
      const missing: string[] = [];
      const keys = expectedRevision === null ? await tx.keys("notes") : [];
      if (keys.some((key) => foldCase(key) === foldCase(path)))
        throw new Error("The sync destination already exists.");
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        const existing = await tx.get("notes", p);
        if (!existing && keys.some((key) => foldCase(key) === foldCase(p)))
          throw new Error(`Another spelling blocks folder ${p}`);
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
  /**
   * Saves an imported note as `<name>.md` in `folder` (`name 2`, `name 3`… if taken, like Android) together with the
   * imported images it still references, in one transaction. Returns the new note's path.
   */
  async importNote(
    folder: string,
    name: string,
    text: string,
    images: ProcessedImage[],
  ): Promise<string> {
    const base = name.trim();
    validatePath(join(folder, `${base}.md`));
    reserved(join(folder, `${base}.md`));
    const referenced = referencedAttachments([text]);
    const used = images.filter((image) => referenced.has(image.path));
    for (const image of used)
      if (
        (await attachmentPath(image.bytes, mimeFor(image.path))) !== image.path
      )
        throw new Error("An imported image has an invalid attachment hash.");
    return this.change(["notes", "attachments"], async (tx) => {
      const notes = await tx.getAll("notes");
      if (folder && !notes.some((note) => note.path === folder && note.folder))
        throw new Error("The destination folder no longer exists.");
      const taken = new Set(notes.map((note) => foldCase(note.path)));
      let path = join(folder, `${base}.md`);
      for (let counter = 2; taken.has(foldCase(path)); counter++)
        path = join(folder, `${base} ${counter}.md`);
      validatePath(path);
      const incoming = new Set(used.map((image) => image.path));
      for (const ref of referenced)
        if (!incoming.has(ref) && !(await tx.get("attachments", ref)))
          throw new Error(
            "An image referenced by this document is missing. Import its image first or remove the reference.",
          );
      let id = newId();
      while (notes.some((note) => noteId(note.text) === id)) id = newId();
      const modifiedAt = Date.now();
      for (const image of used)
        if (!(await tx.get("attachments", image.path)))
          await tx.add("attachments", { ...image, modifiedAt });
      await tx.add("notes", {
        path,
        text: withId(text, id),
        folder: false,
        revision: crypto.randomUUID(),
        modifiedAt,
      });
      return path;
    });
  }
  async delete(path: string): Promise<void> {
    await this.change(["notes"], async (tx) => {
      for (const key of await tx.keys("notes"))
        if (key === path || inside(path, key)) await tx.delete("notes", key);
    });
  }
  async createSyncFolder(path: string, marker?: string): Promise<void> {
    validatePath(path);
    if (!marker) reserved(path);
    await this.change(["notes", "attachments", "values"], async (tx) => {
      if (
        (await tx.keys("notes")).some((key) => foldCase(key) === foldCase(path))
      )
        throw new Error("The sync folder destination already exists.");
      if (marker) {
        if (
          (await tx.get("values", marker)) ||
          (await tx.keys("attachments")).some((key) => inside(path, key))
        )
          throw new Error("The sync folder destination already exists.");
        await tx.put("values", true, marker);
        return;
      }
      const p = parent(path);
      if (p && !(await tx.get("notes", p))?.folder)
        throw new Error("Parent folder does not exist.");
      await tx.add("notes", {
        path,
        folder: true,
        text: "",
        revision: crypto.randomUUID(),
      });
    });
  }
  async deleteEmptyFolder(path: string, marker?: string): Promise<void> {
    await this.change(["notes", "attachments", "values"], async (tx) => {
      if (marker) {
        if ((await tx.keys("attachments")).some((p) => inside(path, p)))
          throw new Error("Folder is not empty; its sync history was kept.");
        await tx.delete("values", marker);
        return;
      }
      const notes = await tx.getAll("notes");
      if (notes.some((n) => inside(path, n.path)))
        throw new Error("Folder is not empty; its sync history was kept.");
      const note = notes.find((n) => n.path === path);
      if (note && !note.folder)
        throw new Error("A note now occupies the folder path.");
      await tx.delete("notes", path);
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
  /** Saves the retry intent and its copy together; a collision never replaces an existing note. */
  async stageSyncCopy(
    key: string,
    pending: unknown,
    copy: { path: string; text: string; modifiedAt: number },
    reuse: boolean,
  ): Promise<void> {
    validatePath(copy.path);
    if (!isNote(copy.path)) throw new Error("Notes must have a .md extension.");
    await this.change(["notes", "values"], async (tx) => {
      const existing = await tx.get("notes", copy.path);
      if (
        (await tx.keys("notes")).some(
          (path) =>
            path !== copy.path && foldCase(path) === foldCase(copy.path),
        )
      )
        throw new Error(
          "The conflicted copy destination is occupied with another spelling.",
        );
      if (
        existing &&
        (!reuse ||
          existing.folder ||
          existing.text !== copy.text ||
          existing.modifiedAt !== copy.modifiedAt)
      )
        throw new Error(
          "The conflicted copy changed; sync again before retrying.",
        );
      const p = parent(copy.path);
      if (p && !(await tx.get("notes", p))?.folder)
        throw new Error(
          "The conflicted copy's parent folder no longer exists.",
        );
      await tx.put("values", pending, key);
      if (!existing)
        await tx.add("notes", {
          ...copy,
          folder: false,
          revision: crypto.randomUUID(),
        });
    });
  }
  /** Commits a sync-only case rename and this drive's history without changing content edit times. */
  async commitSyncRename(
    account: string,
    from: string,
    to: string,
    records: RecordState[],
    expected?: Note[],
    metadataOnly = false,
  ): Promise<void> {
    validatePath(to);
    if (from === to || foldCase(from) !== foldCase(to))
      throw new Error("Sync rename must change only the path's case.");
    await this.change(["notes", "values"], async (tx) => {
      if (expected) {
        const all = await tx.getAll("notes");
        const root = metadataOnly ? to : from;
        const source = all.filter(
          (n) => n.path === root || inside(root, n.path),
        );
        if (
          !source.length ||
          (metadataOnly &&
            all.some((n) => n.path === from || inside(from, n.path))) ||
          source.length !== expected.length ||
          source.some(
            (n) =>
              !expected.some(
                (e) => e.path === n.path && e.revision === n.revision,
              ),
          )
        )
          throw new Error("The item changed while renaming; sync again.");
        if (!metadataOnly) {
          const moving = new Set(source.map((n) => n.path));
          for (const n of source) {
            const target = to + n.path.slice(from.length);
            if (
              all.some(
                (other) =>
                  !moving.has(other.path) &&
                  foldCase(other.path) === foldCase(target),
              )
            )
              throw new Error("The rename destination already exists.");
          }
          const p = parent(to);
          if (p && !all.some((n) => n.path === p && n.folder))
            throw new Error("Destination folder does not exist.");
          for (const n of source) await tx.delete("notes", n.path);
          for (const n of source)
            await tx.add("notes", {
              ...n,
              path: to + n.path.slice(from.length),
              revision: crypto.randomUUID(),
            });
        }
      }
      const prefix = `${account}:base:`;
      for (const key of await tx.keys("values")) {
        if (!key.startsWith(prefix)) continue;
        const path = key.slice(prefix.length);
        if (path !== from && !inside(from, path)) continue;
        const target = prefix + to + path.slice(from.length);
        if ((await tx.get("values", target)) !== undefined)
          throw new Error("The rename destination already has sync history.");
        const value = await tx.get("values", key);
        await tx.delete("values", key);
        await tx.add("values", value, target);
      }
      const move = <T extends { path: string }>(items: T[]): T[] =>
        items.map((item) =>
          item.path === from || inside(from, item.path)
            ? { ...item, path: to + item.path.slice(from.length) }
            : item,
        );
      await saveHistory(
        tx,
        account,
        records,
        move(
          ((await tx.get("values", noticesKey(account))) ??
            []) as FolderNotice[],
        ),
        move(
          ((await tx.get("values", witnessesKey(account))) ??
            []) as FolderWitness[],
        ),
      );
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
  /**
   * Saves a drive's sync records. `replaced` lists folders whose drive identity changed: the history inside them
   * (records and base copies) is dropped in the same transaction, so it can never authorize a deletion later.
   */
  async commitSyncRecords(
    account: string,
    records: RecordState[],
    replaced: string[] = [],
  ): Promise<RecordState[]> {
    return this.change(["values"], async (tx) => {
      for (const folder of replaced)
        records = await retireDescendants(tx, account, records, folder);
      await saveHistory(tx, account, records);
      return records;
    });
  }
  /**
   * Flags notes deleted in this browser and retires the records of preserved folders recreated here, for every drive
   * in one transaction, so that no drive plans with half of it. `review` returns, for a drive's records, the paths
   * deleted locally and the preserved folders recreated locally. Returns the records of the drives that changed.
   */
  async flagLocalHistory(
    accounts: string[],
    review: (records: RecordState[]) => {
      deleted: string[];
      recreated: string[];
    },
  ): Promise<Map<string, RecordState[]>> {
    return this.change(["values"], async (tx) => {
      const changed = new Map<string, RecordState[]>();
      for (const account of accounts) {
        const records = ((await tx.get("values", `${account}:records`)) ??
          []) as RecordState[];
        const { deleted, recreated } = review(records);
        if (!deleted.length && !recreated.length) continue;
        const gone = records.filter((r) => recreated.includes(r.path));
        const next = records
          .filter((r) => !recreated.includes(r.path))
          .map((r) =>
            deleted.includes(r.path) ? { ...r, localDeleted: true } : r,
          );
        const witnesses = (
          ((await tx.get("values", witnessesKey(account))) ??
            []) as FolderWitness[]
        ).filter((w) => !recreated.includes(w.path));
        await saveHistory(tx, account, next, undefined, [
          ...witnesses,
          ...gone.map((r) => ({ path: r.path, remoteId: r.remoteId })),
        ]);
        changed.set(account, next);
      }
      return changed;
    });
  }
  /**
   * Drops the history inside folders recreated here whose drive copy was since replaced by another folder
   * (`folders` maps the drive's folder paths to their ids). Returns the new records if any changed.
   */
  async retireReplacedFolders(
    account: string,
    folders: Map<string, string>,
  ): Promise<RecordState[] | undefined> {
    return this.change(["values"], async (tx) => {
      const replaced = (
        ((await tx.get("values", witnessesKey(account))) ??
          []) as FolderWitness[]
      ).filter(
        (w) => folders.has(w.path) && folders.get(w.path) !== w.remoteId,
      );
      if (!replaced.length) return undefined;
      let records = ((await tx.get("values", `${account}:records`)) ??
        []) as RecordState[];
      for (const w of replaced)
        records = await retireDescendants(tx, account, records, w.path);
      await saveHistory(tx, account, records);
      return records;
    });
  }
  /**
   * Keeps a folder deleted here on a drive that cannot delete it safely, and records a new notice telling the user to
   * remove it by hand. Fails if the folder exists here again or its record changed. `marker` is the value that marks
   * the local attachments folder.
   */
  async preserveRemoteFolder(
    account: string,
    path: string,
    remoteId: string,
    marker?: string,
  ): Promise<RecordState[]> {
    return this.change(["notes", "attachments", "values"], async (tx) => {
      const folded = foldCase(path);
      const here = (key: string) =>
        foldCase(key) === folded || inside(folded, foldCase(key));
      if (
        marker
          ? (await tx.get("values", marker)) ||
            (await tx.keys("attachments")).some(here)
          : (await tx.keys("notes")).some(here)
      )
        throw new Error(
          "The folder was recreated in this browser; it was kept on the drive.",
        );
      const records = ((await tx.get("values", `${account}:records`)) ??
        []) as RecordState[];
      const record = records.find((r) => r.path === path);
      if (!record?.folder || record.remoteId !== remoteId)
        throw new Error("The folder's sync history changed; sync again.");
      if (record.remoteFolderPreserved) return records;
      const next = records.map((r) =>
        r === record ? { ...r, remoteFolderPreserved: true } : r,
      );
      const notices = ((await tx.get("values", noticesKey(account))) ??
        []) as FolderNotice[];
      await saveHistory(tx, account, next, [
        ...notices,
        {
          path,
          remoteId,
          generation: crypto.randomUUID(),
          acknowledged: false,
          active: true,
        },
      ]);
      return next;
    });
  }
  /** Every manual-removal notice of a drive, including retired and acknowledged ones. */
  async folderNotices(account: string): Promise<FolderNotice[]> {
    return (await this.value<FolderNotice[]>(noticesKey(account))) ?? [];
  }
  /** Records that the user saw a manual-removal notice, so it is not shown again. */
  async acknowledgeFolderNotice(
    account: string,
    generation: string,
  ): Promise<void> {
    await this.change(["values"], async (tx) => {
      const notices = ((await tx.get("values", noticesKey(account))) ??
        []) as FolderNotice[];
      if (!notices.some((n) => n.generation === generation))
        throw new Error("The folder notice no longer exists.");
      await tx.put(
        "values",
        notices.map((n) =>
          n.generation === generation ? { ...n, acknowledged: true } : n,
        ),
        noticesKey(account),
      );
    });
  }
  async accounts(): Promise<Account[]> {
    return (await this.value<Account[]>("accounts")) ?? [];
  }
  /** When the account's drive last finished a sync pass without errors (epoch ms); cleared by `forgetAccount`. */
  async lastSync(id: string): Promise<number | undefined> {
    return this.value<number>(`${id}:last-sync`);
  }
  async recordSync(id: string, at: number): Promise<void> {
    await this.put(`${id}:last-sync`, at);
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

export class TreeBusyError extends Error {}

export async function exclusive<T>(
  work: () => Promise<T>,
  options: { ifAvailable?: boolean } = {},
): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser needs Web Locks support for safe editing and sync.",
    );
  return navigator.locks.request("marknotes:tree", options, (lock) => {
    if (!lock)
      throw new TreeBusyError(
        "Another MarkNotes tab is using your notes. Finish its operation or close that tab, then try again.",
      );
    return work();
  });
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
