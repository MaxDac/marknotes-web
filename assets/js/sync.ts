import {
  Store,
  type Account,
  type RecordState,
  inside,
  isNote,
  parent,
  syncable,
  type Note,
} from "./storage";

export interface Entry {
  path: string;
  id: string;
  folder: boolean;
  version: string;
  tag?: string;
  /** Epoch ms of the last content change reported by the drive. */
  modifiedAt?: number;
}
export interface Remote {
  snapshot(): Promise<Entry[]>;
  download(entry: Entry): Promise<string>;
  /** Uploads text, recording `modifiedAt` as the file's modification time. */
  upload(
    path: string,
    text: string,
    previous?: Entry,
    modifiedAt?: number,
  ): Promise<Entry>;
  mkdir(path: string): Promise<Entry>;
  delete(entry: Entry): Promise<void>;
  readManifest(): Promise<string | null>;
  writeManifest(text: string): Promise<void>;
}
interface Manifest {
  format: number;
  app: string;
  deviceId: string;
  updatedAt: number;
  files: {
    [path: string]: { sha256: string; version: string; syncedAt: number };
  };
}
export async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function manifest(text: string | null): Manifest | null {
  if (text === null) return null;
  const m: unknown = JSON.parse(text);
  if (
    typeof m !== "object" ||
    m === null ||
    !("format" in m) ||
    m.format !== 1 ||
    !("files" in m) ||
    typeof m.files !== "object" ||
    m.files === null ||
    Array.isArray(m.files) ||
    !Object.entries(m.files).every(
      ([path, value]: [string, unknown]) =>
        syncable(path) &&
        isNote(path) &&
        typeof value === "object" &&
        value !== null &&
        "sha256" in value &&
        typeof value.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.sha256) &&
        "version" in value &&
        typeof value.version === "string" &&
        "syncedAt" in value &&
        typeof value.syncedAt === "number" &&
        Number.isFinite(value.syncedAt),
    )
  )
    throw new Error(
      "Manifest is unreadable or uses an unsupported format; comparing file content instead.",
    );
  return m as Manifest;
}
export interface Outcome {
  changes: number;
  /** Conflicted copies created for versions that lost newest-wins reconciliation. */
  copies: string[];
  errors: string[];
}
/** Local edit time; notes saved before timestamps existed fall back to their last sync. */
export function localTime(note: Note, record?: RecordState): number {
  return note.modifiedAt ?? record?.syncedAt ?? 0;
}
function copyName(path: string, n: number): string {
  const dot = path.lastIndexOf(".");
  const stem = path.slice(0, dot),
    extension = path.slice(dot);
  return `${stem} (conflicted copy)${n > 1 ? ` ${n}` : ""}${extension}`;
}
export class SyncEngine {
  private records: Map<string, RecordState> = new Map();
  constructor(
    private store: Store,
    private account: Account,
    private remote: Remote,
  ) {}
  private get key(): string {
    return `${this.account.id}:records`;
  }
  private async persist(): Promise<void> {
    await this.store.put(this.key, [...this.records.values()]);
  }
  private async record(entry: Entry, text: string | null): Promise<void> {
    this.records.set(entry.path, {
      path: entry.path,
      folder: entry.folder,
      remoteId: entry.id,
      version: entry.version,
      hash: text === null ? "" : await hash(text),
      syncedAt: Date.now(),
    });
    await this.persist();
  }
  private async forget(path: string): Promise<void> {
    this.records.delete(path);
    await this.persist();
  }
  /** Preserves a losing version beside the note, unless an identical copy already exists. */
  private async keepCopy(
    path: string,
    text: string,
    modifiedAt: number,
    remotePaths: Set<string>,
  ): Promise<string | null> {
    for (let n = 1; ; n++) {
      const candidate = copyName(path, n);
      const existing = await this.store.note(candidate);
      if (existing && !existing.folder && existing.text === text) return null;
      if (existing || remotePaths.has(candidate)) continue;
      const entry = await this.remote.upload(
        candidate,
        text,
        undefined,
        modifiedAt,
      );
      remotePaths.add(candidate);
      await this.store.write(candidate, text, undefined, modifiedAt);
      await this.record(entry, text);
      return candidate;
    }
  }
  async run(): Promise<Outcome> {
    this.records = new Map(
      ((await this.store.value<RecordState[]>(this.key)) ?? []).map((r) => [
        r.path,
        r,
      ]),
    );
    const local = new Map((await this.store.list()).map((n) => [n.path, n]));
    // A failed snapshot aborts the run before any deletion decision is made.
    const entries = await this.remote.snapshot();
    const remote = new Map(
      entries
        .filter((e) => syncable(e.path) && (e.folder || isNote(e.path)))
        .map((e) => [e.path, e]),
    );
    const result: Outcome = { changes: 0, copies: [], errors: [] };
    const remotePaths = new Set(remote.keys());
    let previousManifest: Manifest | null = null;
    try {
      previousManifest = manifest(await this.remote.readManifest());
    } catch (error) {
      result.errors.push(`Manifest: ${message(error)}`);
    }
    const pendingLocal = new Set<string>(),
      pendingRemote = new Set<string>(),
      skipped = new Set<string>();
    const paths = [
      ...new Set([...local.keys(), ...remote.keys(), ...this.records.keys()]),
    ].sort();
    for (const path of paths) {
      const l = local.get(path),
        r = remote.get(path);
      if (l && r && l.folder !== r.folder) {
        skipped.add(path);
        result.errors.push(
          `${path}: is a file on one side and a folder on the other`,
        );
      }
    }
    const blocked = (path: string) =>
      [...skipped].some((s) => s === path || inside(s, path));
    const changed = (r: Entry, record: RecordState) =>
      r.id !== record.remoteId || r.version !== record.version;
    const folders = paths
      .filter(
        (p) =>
          local.get(p)?.folder ||
          remote.get(p)?.folder ||
          this.records.get(p)?.folder,
      )
      .sort((a, b) => a.split("/").length - b.split("/").length);
    for (const path of folders) {
      if (blocked(path)) continue;
      try {
        const l = local.get(path),
          r = remote.get(path),
          record = this.records.get(path);
        if (l && r) {
          await this.record(r, null);
          continue;
        }
        if (l) {
          const survivors = await Promise.all(
            [...local.values()]
              .filter((n) => inside(path, n.path))
              .map(async (n) => {
                const old = this.records.get(n.path);
                return !old || (!n.folder && (await hash(n.text)) !== old.hash);
              }),
          );
          if (!record || survivors.some(Boolean))
            await this.record(await this.remote.mkdir(path), null);
          else pendingLocal.add(path);
        } else if (r) {
          const survivors = [...remote.values()].some(
            (e) =>
              inside(path, e.path) &&
              (!this.records.has(e.path) ||
                (!e.folder && changed(e, this.records.get(e.path)!))),
          );
          if (!record || survivors) {
            if (!(await this.store.note(path)))
              await this.store.create(path, true);
            await this.record(r, null);
            result.changes++;
          } else pendingRemote.add(path);
        } else await this.forget(path);
      } catch (error) {
        skipped.add(path);
        result.errors.push(`${path}: ${message(error)}`);
      }
    }
    for (const path of paths.filter(
      (p) =>
        !(
          local.get(p)?.folder ||
          remote.get(p)?.folder ||
          this.records.get(p)?.folder
        ),
    )) {
      if (blocked(path) || !isNote(path)) continue;
      try {
        const l = local.get(path),
          r = remote.get(path),
          record = this.records.get(path);
        if (!l && !r) {
          await this.forget(path);
          continue;
        }
        if (l && !r) {
          if (!record || (await hash(l.text)) !== record.hash)
            await this.record(
              await this.remote.upload(
                path,
                l.text,
                undefined,
                localTime(l, record),
              ),
              l.text,
            );
          else {
            if (![...pendingLocal].some((f) => inside(f, path))) {
              await this.store.delete(path);
              result.changes++;
            }
            await this.forget(path);
          }
          continue;
        }
        if (r && !l) {
          if (!record || changed(r, record)) {
            const text = await this.remote.download(r);
            await this.store.write(path, text, undefined, r.modifiedAt);
            await this.record(r, text);
            result.changes++;
          } else {
            if (![...pendingRemote].some((f) => inside(f, path)))
              await this.remote.delete(r);
            await this.forget(path);
          }
          continue;
        }
        if (!l || !r) continue;
        const localHash = await hash(l.text);
        const mh = previousManifest?.files[r.path];
        const remoteHash =
          mh?.version === r.version && typeof mh.sha256 === "string"
            ? mh.sha256
            : undefined;
        if (localHash === remoteHash) {
          await this.record(r, l.text);
          continue;
        }
        const lc = !record || localHash !== record.hash;
        const rc = !record || changed(r, record);
        const mine = localTime(l, record);
        if (lc && !rc) {
          await this.record(
            await this.remote.upload(path, l.text, r, mine),
            l.text,
          );
          continue;
        }
        if (!lc && !rc) continue;
        const text = await this.remote.download(r);
        if (text === l.text) {
          await this.record(r, text);
          continue;
        }
        if (!lc) {
          await this.store.write(path, text, undefined, r.modifiedAt);
          await this.record(r, text);
          result.changes++;
          continue;
        }
        // Both sides changed: the most recent edit wins and the other is kept as a copy.
        const theirs = r.modifiedAt ?? record?.syncedAt ?? 0;
        if (theirs > mine) {
          const copy = await this.keepCopy(path, l.text, mine, remotePaths);
          if (copy) result.copies.push(copy);
          await this.store.write(path, text, undefined, theirs);
          await this.record(r, text);
        } else {
          const copy = await this.keepCopy(path, text, theirs, remotePaths);
          if (copy) result.copies.push(copy);
          await this.record(
            await this.remote.upload(path, l.text, r, mine),
            l.text,
          );
        }
        result.changes++;
      } catch (error) {
        result.errors.push(`${path}: ${message(error)}`);
      }
    }
    for (const [pending, localDelete] of [
      [pendingLocal, true],
      [pendingRemote, false],
    ] as const) {
      for (const path of pending) {
        if ([...pending].some((f) => f !== path && inside(f, path))) continue;
        if (result.errors.length || result.copies.some((c) => inside(path, c)))
          continue;
        try {
          if (localDelete) {
            await this.store.delete(path);
            result.changes++;
          } else await this.remote.delete(remote.get(path)!);
          for (const key of this.records.keys())
            if (key === path || inside(path, key)) this.records.delete(key);
          await this.persist();
        } catch (error) {
          result.errors.push(`${path}: ${message(error)}`);
        }
      }
    }
    // Drop conflicts persisted by the former line-merge sync.
    await this.store.remove(`${this.account.id}:conflicts`);
    const files = Object.fromEntries(
      [...this.records.values()]
        .filter((r) => !r.folder)
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((r) => [
          r.path,
          { sha256: r.hash, version: r.version, syncedAt: r.syncedAt },
        ]),
    );
    const comparable = (f: Manifest["files"]) =>
      JSON.stringify(
        Object.entries(f)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([p, v]) => [p, v.sha256, v.version]),
      );
    if (
      !previousManifest ||
      comparable(files) !== comparable(previousManifest.files)
    ) {
      try {
        await this.remote.writeManifest(
          JSON.stringify({
            format: 1,
            app: "MarkNotes",
            deviceId: await this.store.deviceId(),
            updatedAt: Date.now(),
            files,
          }),
        );
      } catch (error) {
        result.errors.push(`Manifest: ${message(error)}`);
      }
    }
    return result;
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export async function syncAll(
  store: Store,
  targets: { account: Account; remote: Remote }[],
): Promise<Map<string, Outcome>> {
  const pending = [...targets],
    counts = new Map<string, number>(),
    outcomes = new Map<string, Outcome>();
  while (pending.length) {
    const target = pending.shift()!,
      id = target.account.id,
      count = counts.get(id) ?? 0;
    if (count >= 3) continue;
    counts.set(id, count + 1);
    try {
      const result = await new SyncEngine(
        store,
        target.account,
        target.remote,
      ).run();
      outcomes.set(id, result);
      if (result.changes)
        for (const other of targets)
          if (other !== target && !pending.includes(other)) {
            if ((counts.get(other.account.id) ?? 0) >= 3)
              result.errors.push(
                "Reconciliation limit reached; sync again to propagate remaining changes.",
              );
            else pending.push(other);
          }
    } catch (error) {
      outcomes.set(id, { changes: 0, copies: [], errors: [message(error)] });
    }
  }
  return outcomes;
}

export async function ensureParents(
  remote: Remote,
  path: string,
): Promise<void> {
  const p = parent(path);
  if (p) await remote.mkdir(p);
}
