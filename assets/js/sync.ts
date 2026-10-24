/**
 * Two-way sync between the browser's note tree and the linked drives.
 *
 * The plan, the three-way merge, the conflict handling, the manifest and the multi-drive order come from the shared
 * sync core ([marknotes-sync](https://github.com/MaxDac/marknotes-sync)), which implements the marknotes-spec sync
 * rules for every MarkNotes app. This module only lists both sides, runs the planned actions against the stores and
 * keeps the per-drive records and base copies.
 */
import {
  type Action,
  type ConflictCopyIntent,
  type LocalEntry,
  type RemoteEntry,
  type ReconcileInput,
  type ExistingCopy,
  type Side,
  DEFAULT_MAX_PASSES,
  MANIFEST_PATH,
  SyncScheduler,
  buildManifest,
  isAttachmentPath,
  isSyncedEntry,
  localDeletions,
  plan,
  reconcile,
  sha256Hex,
} from "@marknotes/sync";
import {
  Store,
  type Account,
  type Note,
  type RecordState,
  inside,
  parent,
} from "./storage";
import { ATTACHMENTS, attachmentHash } from "./attachments";
import { newId } from "./notemeta";
import { syncFailure, type SyncFailure } from "./sync-errors";

export interface Entry {
  path: string;
  id: string;
  folder: boolean;
  version: string;
  tag?: string;
  /** Epoch ms of the last content change reported by the drive. */
  modifiedAt?: number;
}
/** Text notes are UTF-8 strings; attachments are raw bytes. */
export type Content = string | Uint8Array<ArrayBuffer>;
export interface Remote {
  snapshot(): Promise<Entry[]>;
  /** The file's exact bytes: notes are hashed as downloaded and decoded only to be stored as text. */
  downloadBytes(entry: Entry): Promise<Uint8Array<ArrayBuffer>>;
  /** Uploads content, recording `modifiedAt` as the file's modification time. */
  upload(
    path: string,
    content: Content,
    previous?: Entry,
    modifiedAt?: number,
  ): Promise<Entry>;
  /** Creates a new folder, failing if the destination already exists. */
  mkdir(path: string): Promise<Entry>;
  /** Provisions parent/internal folders; may reuse an existing folder. */
  ensureFolder(path: string): Promise<Entry>;
  /** Folder deletion must be atomic and non-recursive, or fail without making a request. */
  delete(entry: Entry): Promise<void>;
  /** Identity-preserving, no-clobber case rename; never marks returned content as synced. */
  rename(entry: Entry, toPath: string): Promise<Entry>;
  readManifest(): Promise<string | null>;
  writeManifest(text: string): Promise<void>;
}
/**
 * A note edited on both sides whose edits could not be merged. The newest version (`winner`) was kept at `path` and
 * the other one was saved as a new note at `copyPath`; see conflicts.ts to merge it back.
 */
export interface SyncConflict {
  path: string;
  copyPath: string;
  winner: Side;
  /** Text of the note the last time both sides agreed, if known. */
  baseText: string | null;
  /** The account (drive) the conflict was found on. */
  driveId: string;
}
export interface Outcome {
  /** Changes made to the local tree (downloads, local deletions, merges, conflicted copies), which other drives need. */
  changes: number;
  conflicts: SyncConflict[];
  errors: string[];
  failures?: SyncFailure[];
}
/** Local edit time; notes saved before timestamps existed fall back to their last sync. */
export function localTime(note: Note, record?: RecordState): number {
  return note.modifiedAt ?? record?.syncedAt ?? 0;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const encoder = new TextEncoder();
// ignoreBOM keeps a leading byte order mark in the text, so valid UTF-8 round-trips byte for byte.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const hashContent = (content: Content): string =>
  sha256Hex(typeof content === "string" ? encoder.encode(content) : content);

/**
 * Decodes downloaded note bytes for the editor. Valid UTF-8, with or without a byte order mark, round-trips exactly,
 * so the recorded hash of the text is the hash of the downloaded bytes and the drive copy is not rewritten. Invalid
 * UTF-8 cannot be stored as text unchanged: it is recorded as stored, so the drive copy is only rewritten once the
 * note is edited.
 */
export const decodeNote = (bytes: Uint8Array<ArrayBuffer>): string =>
  decoder.decode(bytes);
/** Set once the local `attachments/` folder exists, like a directory on disk that outlives its files. */
const ATTACHMENTS_FOLDER = "attachments-folder";
/** Planned-state marker for local folders. */
const FOLDER = "folder";

const toCore = (e: Entry): RemoteEntry => ({
  path: e.path,
  id: e.id,
  isFolder: e.folder,
  version: e.version,
  modifiedMillis: e.modifiedAt ?? 0,
});
const fromCore = (e: RemoteEntry): Entry => ({
  path: e.path,
  id: e.id,
  folder: e.isFolder,
  version: e.version,
  modifiedAt: e.modifiedMillis,
});

interface PendingCopy {
  intent: ConflictCopyIntent;
  copyText: string;
  winnerText: string;
  input: Pick<
    ReconcileInput,
    "path" | "local" | "localModifiedMillis" | "remote" | "remoteEntry" | "base"
  >;
}
interface PendingRename {
  path: string;
  toPath: string;
  remote: Entry;
  tree: Entry[];
}

export class SyncEngine {
  private records = new Map<string, RecordState>();
  /** Snapshot entries by path: they carry provider data (such as OneDrive eTags) that the core does not. */
  private entries = new Map<string, Entry>();
  private modified = new Map<string, number>();
  /** What the plan saw locally: content hashes of notes and attachments, FOLDER for folders. */
  private planned = new Map<string, string>();
  private known = new Set<string>();
  private pending = new Map<string, PendingCopy>();
  private renames = new Map<string, PendingRename>();
  private result: Outcome = { changes: 0, conflicts: [], errors: [] };
  constructor(
    private store: Store,
    private account: Account,
    private remote: Remote,
    private linkedAccounts: Account[] = [],
  ) {}
  private get key(): string {
    return `${this.account.id}:records`;
  }
  private get copyKey(): string {
    return `${this.account.id}:copy-intents`;
  }
  private get renameKey(): string {
    return `${this.account.id}:rename-intents`;
  }
  async run(): Promise<Outcome> {
    this.result = { changes: 0, conflicts: [], errors: [] };
    this.modified.clear();
    this.planned.clear();
    this.records = new Map(
      ((await this.store.value<RecordState[]>(this.key)) ?? []).map((r) => [
        r.path,
        r,
      ]),
    );
    this.pending = new Map(
      ((await this.store.value<PendingCopy[]>(this.copyKey)) ?? []).map((p) => [
        p.intent.path,
        p,
      ]),
    );
    this.renames = new Map(
      ((await this.store.value<PendingRename[]>(this.renameKey)) ?? []).map(
        (r) => [r.path, r],
      ),
    );
    const local = await this.listLocal();
    // A failed snapshot aborts the run before any deletion decision is made.
    const snapshot = await this.remote.snapshot();
    this.entries = new Map(snapshot.map((e) => [e.path, e]));
    this.known = new Set([
      ...local.map((e) => e.path),
      ...snapshot.map((e) => e.path),
    ]);
    for (const rename of this.renames.values())
      await this.guarded(rename.path, () => this.replayRename(rename));
    for (const pending of this.pending.values())
      await this.guarded(pending.intent.copyPath, () =>
        this.recoverCopy(pending),
      );
    for (const [path, hash] of this.planned)
      if (!local.some((e) => e.path === path))
        local.push({
          path,
          isFolder: hash === FOLDER,
          sha256: hash === FOLDER ? undefined : hash,
          modifiedMillis: this.modified.get(path),
        });
    await this.markLocalDeletions(local);
    let manifest: string | null = null;
    try {
      manifest = await this.remote.readManifest();
    } catch {
      // The manifest is an optimisation: sync works without it.
    }
    const { actions } = plan({
      local,
      remote: [...this.entries.values()]
        .filter((e) => isSyncedEntry(e.path, e.folder))
        .map(toCore),
      records: this.coreRecords(),
      manifest,
    });
    for (const action of actions)
      await this.guarded(action.path, () => this.apply(action));
    await this.finishCopies();
    await this.guarded(MANIFEST_PATH, async () => {
      const text = buildManifest(
        this.coreRecords(),
        await this.store.deviceId(),
        Date.now(),
        manifest,
      );
      if (text !== null && text !== undefined)
        await this.remote.writeManifest(text);
    });
    // Drop conflicts persisted by the former line-merge sync.
    await this.store.remove(`${this.account.id}:conflicts`);
    return this.result;
  }
  private coreRecords(records = [...this.records.values()]) {
    return records.map((r) => ({
      path: r.path,
      isFolder: r.folder,
      remoteId: r.remoteId,
      remoteVersion: r.version,
      localHash: r.hash,
      syncedAt: r.syncedAt,
      localDeleted: r.localDeleted ?? false,
    }));
  }
  private async markLocalDeletions(local: LocalEntry[]): Promise<void> {
    const accounts = new Set([
      ...(await this.store.accounts()).map((a) => a.id),
      ...this.linkedAccounts.map((a) => a.id),
      this.account.id,
    ]);
    for (const id of accounts) {
      const key = `${id}:records`;
      const records =
        id === this.account.id
          ? [...this.records.values()]
          : ((await this.store.value<RecordState[]>(key)) ?? []);
      const deleted = new Set(localDeletions(local, this.coreRecords(records)));
      if (!deleted.size) continue;
      const next = records.map((r) =>
        deleted.has(r.path) ? { ...r, localDeleted: true } : r,
      );
      await this.store.put(key, next);
      if (id === this.account.id)
        this.records = new Map(next.map((r) => [r.path, r]));
    }
  }
  private async listLocal(): Promise<LocalEntry[]> {
    const entries: LocalEntry[] = [];
    for (const note of await this.store.list()) {
      if (!isSyncedEntry(note.path, note.folder)) continue;
      if (note.folder) {
        this.planned.set(note.path, FOLDER);
        entries.push({ path: note.path, isFolder: true });
        continue;
      }
      const modified = localTime(note, this.records.get(note.path));
      this.modified.set(note.path, modified);
      const sha256 = hashContent(note.text);
      this.planned.set(note.path, sha256);
      entries.push({
        path: note.path,
        isFolder: false,
        modifiedMillis: modified,
        sha256,
      });
    }
    const attachments = (await this.store.attachments()).filter((a) =>
      isSyncedEntry(a.path, false),
    );
    let folder = !!(await this.store.value<boolean>(ATTACHMENTS_FOLDER));
    if (attachments.length && !folder) {
      await this.store.put(ATTACHMENTS_FOLDER, true);
      folder = true;
    }
    if (folder) {
      this.planned.set(ATTACHMENTS, FOLDER);
      entries.push({ path: ATTACHMENTS, isFolder: true });
    }
    for (const a of attachments) {
      this.modified.set(a.path, a.modifiedAt);
      const sha256 = sha256Hex(a.bytes);
      this.planned.set(a.path, sha256);
      entries.push({
        path: a.path,
        isFolder: false,
        modifiedMillis: a.modifiedAt,
        sha256,
      });
    }
    return entries;
  }
  private async guarded(path: string, step: () => Promise<void>) {
    try {
      await step();
    } catch (error) {
      this.result.errors.push(`${path}: ${message(error)}`);
      (this.result.failures ??= []).push(syncFailure(error));
    }
  }
  private entry(remote: RemoteEntry): Entry {
    return this.entries.get(remote.path) ?? fromCore(remote);
  }
  private async apply(action: Action): Promise<void> {
    switch (action.kind) {
      case "error":
        this.result.errors.push(`${action.path}: ${action.message}`);
        (this.result.failures ??= []).push({ kind: "permanent" });
        return;
      case "recordFolder":
        return this.recordFolder(action.path, action.remoteId);
      case "createRemoteFolder":
        return this.recordFolder(
          action.path,
          (await this.remote.mkdir(action.path)).id,
        );
      case "createLocalFolder":
        await this.createLocalFolder(action.path);
        await this.recordFolder(action.path, action.remoteId);
        this.result.changes++;
        return;
      case "forget":
        return this.forget(action.path);
      case "uploadNew":
      case "uploadRevision": {
        const content = await this.read(action.path);
        const previous =
          action.kind === "uploadRevision"
            ? this.entry(action.remote)
            : undefined;
        const uploaded = await this.remote.upload(
          action.path,
          content,
          previous,
          this.modified.get(action.path),
        );
        return this.recordFile(action.path, uploaded, content);
      }
      case "download":
        if (await this.download(action.path, this.entry(action.remote)))
          this.result.changes++;
        return;
      case "record": {
        await this.upsert(
          action.path,
          this.entry(action.remote),
          action.sha256,
        );
        if (action.updateBase && !isAttachmentPath(action.path))
          await this.store.putBase(
            this.account.id,
            action.path,
            await this.readText(action.path),
          );
        return;
      }
      case "deleteLocal":
        if (!(await this.unchanged(action.path))) return;
        if (isAttachmentPath(action.path))
          await this.store.deleteAttachment(action.path);
        else await this.store.delete(action.path);
        await this.forget(action.path);
        this.result.changes++;
        return;
      case "deleteRemote":
        await this.remote.delete(this.entry(action.remote));
        return this.forget(action.path);
      case "deleteLocalFolder":
        if (!(await this.unchanged(action.path))) return;
        await this.store.deleteEmptyFolder(
          action.path,
          action.path === ATTACHMENTS ? ATTACHMENTS_FOLDER : undefined,
        );
        await this.forgetTree(action.path, action.forget);
        this.result.changes++;
        return;
      case "deleteRemoteFolder":
        await this.remote.delete(this.entry(action.remote));
        return this.forgetTree(action.path, action.forget);
      case "renameLocal":
      case "renameRemote": {
        const metadataOnly =
          action.kind === "renameLocal" &&
          !(await this.store.note(action.path));
        const localPath = metadataOnly ? action.toPath : action.path;
        const expected = (await this.store.list()).filter(
          (n) => n.path === localPath || inside(localPath, n.path),
        );
        if (action.kind === "renameLocal") {
          if (
            !(await this.unchanged(localPath)) ||
            (!action.isFolder &&
              (await this.current(localPath)) !== action.sha256)
          )
            throw new Error(
              "The stale spelling changed; sync again before renaming.",
            );
        } else {
          const note = await this.store.note(action.toPath);
          if (
            !note ||
            note.folder !== action.isFolder ||
            (!note.folder &&
              action.sha256 !== null &&
              hashContent(note.text) !== action.sha256)
          )
            throw new Error(
              "The renamed item changed; sync again before renaming.",
            );
          const rename: PendingRename = {
            path: action.path,
            toPath: action.toPath,
            remote: this.entry(action.remote),
            tree: [...this.entries.values()].filter(
              (e) => e.path === action.path || inside(action.path, e.path),
            ),
          };
          this.renames.set(rename.path, rename);
          await this.store.put(this.renameKey, [...this.renames.values()]);
          return this.replayRename(rename);
        }
        const records = [...this.records.values()].map((r) =>
          r.path === action.path || inside(action.path, r.path)
            ? { ...r, path: action.toPath + r.path.slice(action.path.length) }
            : r,
        );
        await this.store.commitSyncRename(
          this.account.id,
          action.path,
          action.toPath,
          records,
          action.kind === "renameLocal" ? expected : undefined,
          metadataOnly,
        );
        this.records = new Map(records.map((r) => [r.path, r]));
        if (action.kind === "renameLocal" && !metadataOnly)
          this.result.changes++;
        return;
      }
      case "reconcile":
        return this.reconcile(action.path, action.remote, action.hasRecord);
    }
  }
  /** The note changed on both sides: keep it, merge it, or keep the newest and save the other as a copy. */
  private async reconcile(
    path: string,
    remoteEntry: RemoteEntry,
    hasRecord: boolean,
  ): Promise<void> {
    const entry = this.entry(remoteEntry);
    const local = await this.readText(path);
    // Edited since planning: left for the next sync, which plans with the new text.
    if (hashContent(local) !== this.planned.get(path)) return;
    const remote = decodeNote(await this.remote.downloadBytes(entry));
    const baseText = hasRecord
      ? ((await this.store.base(this.account.id, path)) ?? null)
      : null;
    const localModified = this.modified.get(path) ?? 0;
    const pending = this.pending.get(path);
    const existing =
      pending && (await this.store.note(pending.intent.copyPath));
    const outcome = reconcile({
      path,
      local,
      localModifiedMillis: localModified,
      remote,
      remoteEntry,
      base: baseText,
      existingPaths: [...this.known],
      newId: newId(),
      conflictCopyIntent: pending?.intent ?? null,
      existingCopy:
        existing && !existing.folder
          ? {
              path: existing.path,
              text: existing.text,
              modifiedMillis: existing.modifiedAt ?? 0,
            }
          : null,
    });
    switch (outcome.kind) {
      case "same":
        return this.recordFile(path, entry, local);
      case "merged": {
        const now = Date.now();
        if (!(await this.writeIfUnchanged(path, outcome.text, now))) return;
        await this.recordFile(
          path,
          await this.remote.upload(path, outcome.text, entry, now),
          outcome.text,
        );
        this.result.changes++;
        return;
      }
      case "newestWins": {
        const localWins = outcome.winner === "local";
        // The copy keeps the modification time of the version that lost.
        const copyTime = outcome.copyModifiedMillis;
        const next: PendingCopy = {
          intent: outcome.conflictCopyIntent,
          copyText: outcome.copyText,
          winnerText: localWins ? local : remote,
          input: {
            path,
            local,
            localModifiedMillis: localModified,
            remote,
            remoteEntry,
            base: baseText,
          },
        };
        const pendingCopies = new Map(this.pending).set(path, next);
        // Save the losing version locally before anything overwrites it, so a failing step never loses it.
        await this.store.stageSyncCopy(
          this.copyKey,
          [...pendingCopies.values()],
          {
            path: outcome.copyPath,
            text: outcome.copyText,
            modifiedAt: copyTime,
          },
          outcome.reuseCopy,
        );
        this.pending = pendingCopies;
        this.known.add(outcome.copyPath);
        this.planned.set(outcome.copyPath, hashContent(outcome.copyText));
        this.modified.set(outcome.copyPath, copyTime);
        this.result.conflicts.push({
          path,
          copyPath: outcome.copyPath,
          winner: outcome.winner,
          baseText,
          driveId: this.account.id,
        });
        this.result.changes++;
        if (localWins)
          await this.recordFile(
            path,
            await this.remote.upload(path, local, entry, localModified),
            local,
          );
        else {
          if (
            !(await this.writeIfUnchanged(path, remote, entry.modifiedAt ?? 0))
          )
            throw new Error("changed while syncing; will sync again");
          await this.recordFile(path, entry, remote);
        }
        await this.uploadCopy(next);
        return;
      }
    }
  }
  private async uploadCopy(pending: PendingCopy): Promise<void> {
    const { copyPath: path, copyModifiedMillis: modifiedAt } = pending.intent;
    const existing = this.entries.get(path);
    let entry: Entry;
    if (existing) {
      if (
        existing.folder ||
        decodeNote(await this.remote.downloadBytes(existing)) !==
          pending.copyText ||
        !this.sameRemoteTime(existing.modifiedAt ?? 0, modifiedAt)
      )
        throw new Error(
          "The remote conflicted copy changed; it was not replaced.",
        );
      entry = existing;
    } else {
      entry = await this.remote.upload(
        path,
        pending.copyText,
        undefined,
        modifiedAt,
      );
    }
    if (
      entry.folder ||
      entry.path !== path ||
      !this.sameRemoteTime(entry.modifiedAt ?? 0, modifiedAt)
    )
      throw new Error(
        "The drive did not preserve the conflicted copy's path and edit time.",
      );
    this.entries.set(path, entry);
    await this.recordFile(path, entry, pending.copyText);
  }
  private async replayRename(rename: PendingRename): Promise<void> {
    const current = [...this.entries.values()].find(
      (e) => e.id === rename.remote.id,
    );
    if (!current || current.folder !== rename.remote.folder)
      throw new Error(
        "The pending rename's remote identity changed; its history was kept.",
      );
    if (current.path === rename.path) {
      const target = await this.store.note(rename.toPath);
      const tree = [...this.entries.values()].filter(
        (e) => e.path === rename.path || inside(rename.path, e.path),
      );
      if (
        !target ||
        target.folder !== current.folder ||
        tree.length !== rename.tree.length ||
        tree.some(
          (e) =>
            !rename.tree.some(
              (old) =>
                old.path === e.path &&
                old.id === e.id &&
                old.folder === e.folder &&
                old.version === e.version &&
                old.tag === e.tag,
            ),
        )
      )
        throw new Error(
          "The pending rename changed before completion; sync again.",
        );
      const moved = await this.remote.rename(current, rename.toPath);
      for (const entry of tree) {
        this.entries.delete(entry.path);
        const path = rename.toPath + entry.path.slice(rename.path.length);
        this.entries.set(
          path,
          entry.id === moved.id ? moved : { ...entry, path },
        );
      }
    } else if (current.path !== rename.toPath)
      throw new Error(
        "The pending rename moved elsewhere; its history was kept.",
      );
    const records = [...this.records.values()].map((r) =>
      r.path === rename.path || inside(rename.path, r.path)
        ? { ...r, path: rename.toPath + r.path.slice(rename.path.length) }
        : r,
    );
    if (new Set(records.map((r) => r.path)).size !== records.length)
      throw new Error("The rename destination already has sync history.");
    await this.store.commitSyncRename(
      this.account.id,
      rename.path,
      rename.toPath,
      records,
    );
    this.records = new Map(records.map((r) => [r.path, r]));
    this.renames.delete(rename.path);
    await this.store.put(this.renameKey, [...this.renames.values()]);
  }
  private sameRemoteTime(actual: number, expected: number): boolean {
    return (
      actual === expected ||
      (this.account.provider === "dropbox" &&
        actual === Math.floor(expected / 1000) * 1000)
    );
  }
  private async recoverCopy(pending: PendingCopy): Promise<void> {
    const old = await this.store.note(pending.intent.copyPath);
    const remote = this.entries.get(pending.intent.copyPath);
    let existing: ExistingCopy | null =
      old && !old.folder
        ? {
            path: old.path,
            text: old.text,
            modifiedMillis: old.modifiedAt ?? 0,
          }
        : null;
    if (old?.folder) existing = { path: old.path, text: "", modifiedMillis: 0 };
    if (
      remote &&
      (!existing ||
        (existing.text === pending.copyText &&
          existing.modifiedMillis === pending.intent.copyModifiedMillis))
    ) {
      const text = remote.folder
        ? ""
        : decodeNote(await this.remote.downloadBytes(remote));
      existing = {
        path: remote.path,
        text,
        modifiedMillis: this.sameRemoteTime(
          remote.modifiedAt ?? 0,
          pending.intent.copyModifiedMillis,
        )
          ? pending.intent.copyModifiedMillis
          : (remote.modifiedAt ?? 0),
      };
    }
    const outcome = reconcile({
      ...pending.input,
      existingPaths: [...this.known],
      newId: newId(),
      conflictCopyIntent: pending.intent,
      existingCopy: existing,
    });
    if (outcome.kind !== "newestWins")
      throw new Error(
        "The saved conflict intent is inconsistent; its copy was preserved.",
      );
    const next: PendingCopy = {
      ...pending,
      intent: outcome.conflictCopyIntent,
      copyText: outcome.copyText,
    };
    const copies = new Map(this.pending).set(next.intent.path, next);
    const { copyPath: path, copyModifiedMillis: modifiedAt } = next.intent;
    const current = await this.store.note(path);
    await this.store.stageSyncCopy(
      this.copyKey,
      [...copies.values()],
      { path, text: next.copyText, modifiedAt },
      outcome.reuseCopy,
    );
    this.pending = copies;
    if (!current) {
      this.result.changes++;
      this.planned.set(path, hashContent(next.copyText));
      this.modified.set(path, modifiedAt);
    }
    this.known.add(path);
    this.result.conflicts.push({
      path: next.intent.path,
      copyPath: path,
      winner: outcome.winner,
      baseText: next.input.base ?? null,
      driveId: this.account.id,
    });
    await this.uploadCopy(next);
  }
  private async finishCopies(): Promise<void> {
    this.pending = new Map(
      ((await this.store.value<PendingCopy[]>(this.copyKey)) ?? []).map((p) => [
        p.intent.path,
        p,
      ]),
    );
    for (const [path, pending] of this.pending) {
      const record = this.records.get(path);
      const remote = this.entries.get(path);
      const copyRecord = this.records.get(pending.intent.copyPath);
      const copyRemote = this.entries.get(pending.intent.copyPath);
      const copy = await this.store.note(pending.intent.copyPath);
      if (
        record &&
        remote &&
        copyRecord?.hash === hashContent(pending.copyText) &&
        copyRemote &&
        copyRemote.id === copyRecord.remoteId &&
        copyRemote.version === copyRecord.version &&
        copy?.text === pending.copyText &&
        copy.modifiedAt === pending.intent.copyModifiedMillis &&
        record.hash === hashContent(pending.winnerText) &&
        record.remoteId === remote.id &&
        record.version === remote.version &&
        (await this.current(path)) === record.hash
      )
        this.pending.delete(path);
    }
    await this.store.put(this.copyKey, [...this.pending.values()]);
  }
  /** What is stored locally at `path` now, in the form of `planned`. */
  private async current(path: string): Promise<string | undefined> {
    if (path === ATTACHMENTS)
      return (await this.store.value<boolean>(ATTACHMENTS_FOLDER))
        ? FOLDER
        : undefined;
    if (isAttachmentPath(path)) {
      const file = await this.store.attachment(path);
      return file && sha256Hex(file.bytes);
    }
    const note = await this.store.note(path);
    if (!note) return undefined;
    return note.folder ? FOLDER : hashContent(note.text);
  }
  /**
   * True when `path`, and everything inside it for a folder, is still what the plan saw. Local writes and deletes
   * check this first and otherwise skip the step, leaving it for the next sync.
   */
  private async unchanged(path: string): Promise<boolean> {
    const planned = this.planned.get(path);
    if ((await this.current(path)) !== planned) return false;
    if (planned !== FOLDER) return true;
    const children =
      path === ATTACHMENTS
        ? await this.store.attachmentPaths()
        : (await this.store.list())
            .map((n) => n.path)
            .filter((p) => inside(path, p));
    for (const child of children)
      if ((await this.current(child)) !== this.planned.get(child)) return false;
    return true;
  }
  /** Writes a note unless it changed since planning; the revision check makes the comparison and write atomic. */
  private async writeIfUnchanged(
    path: string,
    text: string,
    modifiedAt?: number,
  ): Promise<boolean> {
    const note = await this.store.note(path);
    const now = note && (note.folder ? FOLDER : hashContent(note.text));
    if (now !== this.planned.get(path)) return false;
    await this.store.write(path, text, note?.revision ?? null, modifiedAt);
    return true;
  }
  private async read(path: string): Promise<Content> {
    if (!isAttachmentPath(path)) return this.readText(path);
    const file = await this.store.attachment(path);
    if (!file) throw new Error("no longer exists in this browser");
    return file.bytes;
  }
  private async readText(path: string): Promise<string> {
    const note = await this.store.note(path);
    if (!note || note.folder)
      throw new Error("no longer exists in this browser");
    return note.text;
  }
  /** Downloads `path` unless it changed locally since planning; true when it was written. */
  private async download(path: string, entry: Entry): Promise<boolean> {
    const bytes = await this.remote.downloadBytes(entry);
    if (isAttachmentPath(path)) {
      if (sha256Hex(bytes) !== attachmentHash(path))
        throw new Error("content does not match its name; skipped");
      if (!(await this.unchanged(path))) return false;
      await this.store.putAttachment(path, bytes, entry.modifiedAt ?? 0);
      await this.store.put(ATTACHMENTS_FOLDER, true);
      await this.recordFile(path, entry, bytes);
      return true;
    }
    const text = decodeNote(bytes);
    if (!(await this.writeIfUnchanged(path, text, entry.modifiedAt ?? 0)))
      return false;
    await this.recordFile(path, entry, text);
    return true;
  }
  private async createLocalFolder(path: string): Promise<void> {
    await this.store.createSyncFolder(
      path,
      path === ATTACHMENTS ? ATTACHMENTS_FOLDER : undefined,
    );
  }
  /** Records a synced file and, for notes, keeps `content` as the base copy for later merges. */
  private async recordFile(
    path: string,
    entry: Entry,
    content: Content,
  ): Promise<void> {
    await this.upsert(path, entry, hashContent(content));
    if (typeof content === "string" && !isAttachmentPath(path))
      await this.store.putBase(this.account.id, path, content);
  }
  private async upsert(path: string, entry: Entry, hash: string) {
    this.entries.set(path, entry);
    this.records.set(path, {
      path,
      folder: false,
      remoteId: entry.id,
      version: entry.version,
      hash,
      syncedAt: Date.now(),
    });
    await this.persist();
  }
  private async recordFolder(path: string, remoteId: string): Promise<void> {
    this.records.set(path, {
      path,
      folder: true,
      remoteId,
      version: "",
      hash: "",
      syncedAt: Date.now(),
    });
    await this.persist();
  }
  private async forget(path: string): Promise<void> {
    this.records.delete(path);
    await this.persist();
    await this.store.deleteBase(this.account.id, path);
  }
  private async forgetTree(folder: string, paths: string[]): Promise<void> {
    for (const path of [folder, ...paths]) this.records.delete(path);
    await this.persist();
    await this.store.deleteBase(this.account.id, folder);
  }
  private async persist(): Promise<void> {
    await this.store.put(this.key, [...this.records.values()]);
  }
}

/**
 * Keeps the browser's note tree and every linked drive identical. The order comes from the core's `SyncScheduler`:
 * when a drive brings local changes, the other drives are synced again so they receive them (at most
 * `DEFAULT_MAX_PASSES` times each). Each outcome holds the last pass's errors and the conflicts of every pass.
 */
export async function syncAll(
  store: Store,
  targets: { account: Account; remote: Remote }[],
): Promise<Map<string, Outcome>> {
  const byId = new Map(targets.map((t) => [t.account.id, t]));
  const outcomes = new Map<string, Outcome>();
  const scheduler = new SyncScheduler([...byId.keys()], DEFAULT_MAX_PASSES);
  try {
    for (let id = scheduler.next(); id !== undefined; id = scheduler.next()) {
      const target = byId.get(id)!;
      let outcome: Outcome,
        failed = false;
      try {
        outcome = await new SyncEngine(
          store,
          target.account,
          target.remote,
          targets.map((t) => t.account),
        ).run();
      } catch (error) {
        outcome = {
          changes: 0,
          conflicts: [],
          errors: [message(error)],
          failures: [syncFailure(error)],
        };
        failed = true;
      }
      outcome.conflicts.unshift(...(outcomes.get(id)?.conflicts ?? []));
      outcomes.set(id, outcome);
      scheduler.report(id, failed ? 0 : outcome.changes, failed);
    }
  } finally {
    scheduler.free();
  }
  return outcomes;
}

export async function ensureParents(
  remote: Remote,
  path: string,
): Promise<void> {
  const p = parent(path);
  if (p) await remote.ensureFolder(p);
}
