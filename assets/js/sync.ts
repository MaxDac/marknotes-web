import {
  Store,
  type Account,
  type RecordState,
  inside,
  isNote,
  parent,
  syncable,
} from "./storage";
import { merge, renderMerge, type Chunk } from "./merge";

export interface Entry {
  path: string;
  id: string;
  folder: boolean;
  version: string;
  tag?: string;
}
export interface Remote {
  snapshot(): Promise<Entry[]>;
  download(entry: Entry): Promise<string>;
  upload(path: string, text: string, previous?: Entry): Promise<Entry>;
  mkdir(path: string): Promise<Entry>;
  delete(entry: Entry): Promise<void>;
  readManifest(): Promise<string | null>;
  writeManifest(text: string): Promise<void>;
}
export interface Conflict {
  path: string;
  mine: string;
  theirs: string;
  remote: Entry;
  chunks: Chunk[];
  base: string | null;
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
  conflicts: Conflict[];
  errors: string[];
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
      base: text,
      syncedAt: Date.now(),
    });
    await this.persist();
  }
  private async forget(path: string): Promise<void> {
    this.records.delete(path);
    await this.persist();
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
    const result: Outcome = { changes: 0, conflicts: [], errors: [] };
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
            await this.record(await this.remote.upload(path, l.text), l.text);
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
            await this.store.write(path, text);
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
        if (lc && !rc) {
          await this.record(await this.remote.upload(path, l.text, r), l.text);
          continue;
        }
        if (!lc && !rc) continue;
        const text = await this.remote.download(r);
        if (text === l.text) {
          await this.record(r, text);
          continue;
        }
        if (!lc) {
          await this.store.write(path, text);
          await this.record(r, text);
          result.changes++;
          continue;
        }
        const chunks = merge(record?.base ?? null, l.text, text);
        if (
          record?.base !== null &&
          record?.base !== undefined &&
          !chunks.some((c) => c.conflict)
        ) {
          const merged = renderMerge(chunks, []);
          const updated = await this.remote.upload(path, merged, r);
          await this.store.write(path, merged);
          await this.record(updated, merged);
          result.changes++;
        } else
          result.conflicts.push({
            path,
            mine: l.text,
            theirs: text,
            remote: r,
            chunks,
            base: record?.base ?? null,
          });
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
        if (
          result.errors.length ||
          result.conflicts.some((c) => inside(path, c.path))
        )
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
    await this.store.put(`${this.account.id}:conflicts`, result.conflicts);
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
  async resolve(
    conflict: Conflict,
    text: string,
    keepBoth = false,
  ): Promise<void> {
    const local = await this.store.note(conflict.path);
    const current = (await this.remote.snapshot()).find(
      (r) => r.path === conflict.path,
    );
    if (
      local?.text !== conflict.mine ||
      current?.id !== conflict.remote.id ||
      current?.version !== conflict.remote.version
    )
      throw new Error(
        "The note changed since this conflict. Sync again before resolving.",
      );
    this.records = new Map(
      ((await this.store.value<RecordState[]>(this.key)) ?? []).map((r) => [
        r.path,
        r,
      ]),
    );
    if (keepBoth) {
      const dot = conflict.path.lastIndexOf(".");
      const stem = conflict.path.slice(0, dot),
        extension = conflict.path.slice(dot);
      let path = `${stem} (conflicted copy)${extension}`,
        n = 2;
      const remotePaths = new Set(
        (await this.remote.snapshot()).map((e) => e.path),
      );
      while ((await this.store.note(path)) || remotePaths.has(path))
        path = `${stem} (conflicted copy) ${n++}${extension}`;
      const entry = await this.remote.upload(path, conflict.theirs);
      await this.store.write(path, conflict.theirs);
      await this.record(entry, conflict.theirs);
    }
    const updated = await this.remote.upload(conflict.path, text, current);
    await this.store.write(conflict.path, text);
    await this.record(updated, text);
    const conflicts =
      (await this.store.value<Conflict[]>(`${this.account.id}:conflicts`)) ??
      [];
    await this.store.put(
      `${this.account.id}:conflicts`,
      conflicts.filter((c) => c.path !== conflict.path),
    );
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
      outcomes.set(id, { changes: 0, conflicts: [], errors: [message(error)] });
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
