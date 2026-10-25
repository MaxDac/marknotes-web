import { Auth, ApiError, request } from "./auth";
import { type Account, join, inside, parent } from "./storage";
import { type Content, type Entry, type Remote, ensureParents } from "./sync";
import { foldCase } from "@marknotes/sync";

export interface CloudFolder {
  path: string;
  name: string;
}
export interface Drive extends Remote {
  folders(path: string): Promise<CloudFolder[]>;
}
interface DropboxItem {
  ".tag": string;
  id: string;
  name: string;
  path_display?: string;
  path_lower: string;
  rev?: string;
  client_modified?: string;
  server_modified?: string;
}
/** Parses an ISO timestamp, ignoring absent or malformed values. */
function time(value?: string): number | undefined {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}
/** Dropbox requires second-precision UTC timestamps. */
function dropboxTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
interface DropboxPage {
  entries: DropboxItem[];
  cursor: string;
  has_more: boolean;
}
const encode = (content: Content): Uint8Array<ArrayBuffer> =>
  typeof content === "string" ? new TextEncoder().encode(content) : content;
function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export class Dropbox implements Drive {
  /** Dropbox deletes folders recursively: folders deleted here are kept and the user removes them by hand. */
  readonly remoteFolderDeletion = "unsupported";
  private entries = new Map<string, Entry>();
  private cursor?: string;
  private rootReady = false;
  constructor(
    private auth: Auth,
    private account: Account,
  ) {}
  private absolute(path: string): string {
    return `/${[this.account.folder, path].filter(Boolean).join("/")}`;
  }
  private async api<T>(route: string, data: unknown): Promise<T> {
    const r = await this.auth.authorized(
      this.account,
      `https://api.dropboxapi.com/2/files/${route}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    if (!r.ok) {
      const detail = await r.text();
      // Dropbox uses 409 for both missing paths and concurrent writes.
      if (r.status === 409 && detail.includes("not_found"))
        throw new ApiError(404, "Dropbox");
      if (r.status === 409 && detail.includes("reset"))
        throw new ApiError(410, "Dropbox cursor");
      throw new ApiError(r.status, "Dropbox");
    }
    return (await r.json()) as T;
  }
  private async createAbsolute(path: string): Promise<DropboxItem> {
    try {
      return (
        await this.api<{ metadata: DropboxItem }>("create_folder_v2", {
          path,
          autorename: false,
        })
      ).metadata;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      const item = await this.api<DropboxItem>("get_metadata", { path });
      if (item[".tag"] !== "folder")
        throw new Error("A file blocks the cloud folder.", { cause: error });
      return item;
    }
  }
  private async root(): Promise<void> {
    if (this.rootReady) return;
    let path = "";
    for (const part of this.account.folder.split("/").filter(Boolean)) {
      path += `/${part}`;
      await this.createAbsolute(path);
    }
    this.rootReady = true;
  }
  private entry(item: DropboxItem): Entry {
    const full = item.path_display ?? item.path_lower;
    return {
      path: full
        .slice(this.account.folder ? this.account.folder.length + 1 : 0)
        .replace(/^\//, ""),
      id: item.id,
      folder: item[".tag"] === "folder",
      version: item.rev ?? "",
      modifiedAt: time(item.client_modified ?? item.server_modified),
    };
  }
  private remember(item: DropboxItem): Entry {
    const entry = this.entry(item);
    this.entries.set(entry.path.toLowerCase(), entry);
    return entry;
  }
  async snapshot(): Promise<Entry[]> {
    await this.root();
    let page: DropboxPage;
    try {
      page = this.cursor
        ? await this.api("list_folder/continue", { cursor: this.cursor })
        : await this.api("list_folder", {
            path: this.account.folder ? `/${this.account.folder}` : "",
            recursive: true,
            include_deleted: true,
          });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 410 || !this.cursor)
        throw error;
      this.cursor = undefined;
      this.entries.clear();
      return this.snapshot();
    }
    // Commit a complete page sequence atomically; failures never expose a partial snapshot.
    const next = new Map(this.entries);
    while (true) {
      for (const item of page.entries) {
        const entry = this.entry(item),
          key = entry.path.toLowerCase();
        if (item[".tag"] === "deleted") {
          for (const p of next.keys())
            if (p === key || inside(key, p)) next.delete(p);
        } else next.set(key, entry);
      }
      if (!page.has_more) break;
      page = await this.api("list_folder/continue", { cursor: page.cursor });
    }
    this.cursor = page.cursor;
    this.entries = next;
    return [...next.values()].filter(
      (e) => !e.path.split("/").some((p) => p.startsWith(".")),
    );
  }
  async downloadBytes(entry: Entry): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await (await this.fetchPath(entry.id)).arrayBuffer());
  }
  private async fetchPath(path: string): Promise<Response> {
    const r = await this.auth.authorized(
      this.account,
      "https://content.dropboxapi.com/2/files/download",
      {
        method: "POST",
        headers: { "Dropbox-API-Arg": headerJson({ path }) },
      },
    );
    if (!r.ok) {
      const detail = await r.text();
      if (r.status === 409 && detail.includes("not_found"))
        throw new ApiError(404, "Dropbox");
      throw new ApiError(r.status, "Dropbox");
    }
    return r;
  }
  private async put(
    path: string,
    content: Content,
    mode: unknown,
    modifiedAt?: number,
  ): Promise<DropboxItem> {
    const r = await this.auth.authorized(
      this.account,
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": headerJson({
            path: this.absolute(path),
            mode,
            autorename: false,
            mute: true,
            strict_conflict: true,
            ...(modifiedAt === undefined
              ? {}
              : { client_modified: dropboxTime(modifiedAt) }),
          }),
        },
        body: encode(content),
      },
    );
    if (!r.ok) throw new ApiError(r.status, "Dropbox");
    return r.json() as Promise<DropboxItem>;
  }
  async upload(
    path: string,
    content: Content,
    previous?: Entry,
    modifiedAt?: number,
  ): Promise<Entry> {
    await ensureParents(this, path);
    return this.remember(
      await this.put(
        path,
        content,
        previous ? { ".tag": "update", update: previous.version } : "add",
        modifiedAt,
      ),
    );
  }
  async mkdir(path: string): Promise<Entry> {
    await ensureParents(this, path);
    return this.remember(
      (
        await this.api<{ metadata: DropboxItem }>("create_folder_v2", {
          path: this.absolute(path),
          autorename: false,
        })
      ).metadata,
    );
  }
  async ensureFolder(path: string): Promise<Entry> {
    let result: DropboxItem | undefined,
      current = "";
    for (const part of path.split("/")) {
      current = join(current, part);
      result = await this.createAbsolute(this.absolute(current));
    }
    if (!result) throw new Error("Missing folder path.");
    return this.remember(result);
  }
  /** File deletes are conditional on the snapshot revision; a newer revision fails with 409 and keeps the file. */
  async delete(entry: Entry): Promise<void> {
    if (entry.folder)
      throw new Error(
        "Dropbox cannot safely delete folders atomically without deleting unseen children; the folder and sync history were kept.",
      );
    if (!entry.version)
      throw new Error(
        "Dropbox omitted the revision guard; sync again before deleting.",
      );
    try {
      await this.api("delete_v2", {
        path: entry.id,
        parent_rev: entry.version,
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    const key = entry.path.toLowerCase();
    for (const p of this.entries.keys())
      if (p === key || inside(key, p)) this.entries.delete(p);
  }
  async readManifest(): Promise<string | null> {
    try {
      return await (
        await this.fetchPath(this.absolute(".marknotes/manifest.json"))
      ).text();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  async rename(entry: Entry, toPath: string): Promise<Entry> {
    if (entry.path === toPath)
      throw new Error("Sync rename must change the path's case.");
    throw new Error(
      "Dropbox does not support safe case-only remote renames; the note and sync history were kept. Rename the drive item to a distinct name first.",
    );
  }
  async writeManifest(text: string): Promise<void> {
    await this.createAbsolute(this.absolute(".marknotes"));
    await this.put(".marknotes/manifest.json", text, "overwrite");
  }
  async folders(path: string): Promise<CloudFolder[]> {
    const all: DropboxItem[] = [];
    let page = await this.api<DropboxPage>("list_folder", {
      path: path ? `/${path}` : "",
    });
    while (true) {
      all.push(...page.entries);
      if (!page.has_more) break;
      page = await this.api("list_folder/continue", { cursor: page.cursor });
    }
    return all
      .filter((i) => i[".tag"] === "folder")
      .map((i) => ({
        path: (i.path_display ?? i.path_lower).replace(/^\//, ""),
        name: i.name,
      }));
  }
}

interface GraphItem {
  id: string;
  name: string;
  folder?: object;
  deleted?: object;
  "@removed"?: object;
  parentReference?: { id?: string };
  cTag?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  fileSystemInfo?: { lastModifiedDateTime?: string };
  "@microsoft.graph.downloadUrl"?: string;
}
interface GraphPage {
  value: GraphItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}
/** Hosts OneDrive serves pre-authenticated downloads from; mirrored in the CSP (Caddyfile). */
const DOWNLOAD_HOSTS = [
  ".1drv.com",
  ".microsoftpersonalcontent.com",
  ".sharepoint.com",
];
function downloadHost(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return (
    protocol === "https:" && DOWNLOAD_HOSTS.some((h) => hostname.endsWith(h))
  );
}
function graphTime(node: GraphItem): number | undefined {
  return time(
    node.fileSystemInfo?.lastModifiedDateTime ?? node.lastModifiedDateTime,
  );
}
export class OneDrive implements Drive {
  /** Graph deletes folders recursively: folders deleted here are kept and the user removes them by hand. */
  readonly remoteFolderDeletion = "unsupported";
  private rootId?: string;
  private nodes = new Map<string, GraphItem>();
  private delta?: string;
  constructor(
    private auth: Auth,
    private account: Account,
  ) {}
  private path(path: string): string {
    return path
      ? `/me/drive/root:/${path.split("/").map(encodeURIComponent).join("/")}:`
      : "/me/drive/root";
  }
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith("https:")
      ? path
      : `https://graph.microsoft.com/v1.0${path}`;
    if (new URL(url).origin !== "https://graph.microsoft.com")
      throw new Error("Untrusted Microsoft Graph continuation URL.");
    const r = await this.auth.authorized(this.account, url, init);
    if (!r.ok) throw new ApiError(r.status, "OneDrive");
    return (r.status === 204 ? undefined : await r.json()) as T;
  }
  private async child(parentId: string, name: string): Promise<GraphItem> {
    try {
      return await this.api(
        `/me/drive/items/${encodeURIComponent(parentId)}/children`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            folder: {},
            "@microsoft.graph.conflictBehavior": "fail",
          }),
        },
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      const item = await this.api<GraphItem>(
        `/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`,
      );
      if (!item.folder)
        throw new Error("A file blocks the cloud folder.", { cause: error });
      return item;
    }
  }
  private async root(): Promise<string> {
    if (this.rootId) return this.rootId;
    let item = await this.api<GraphItem>("/me/drive/root");
    for (const part of this.account.folder.split("/").filter(Boolean)) {
      try {
        item = await this.api<GraphItem>(
          `/me/drive/items/${encodeURIComponent(item.id)}:/${encodeURIComponent(part)}`,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        item = await this.child(item.id, part);
      }
      if (!item.folder)
        throw new Error("Selected sync location is not a folder.");
    }
    this.rootId = item.id;
    return item.id;
  }
  private entries(): Entry[] {
    const result: Entry[] = [],
      paths = new Map<string, string>([[this.rootId!, ""]]);
    let pending = [...this.nodes.values()];
    while (pending.length) {
      const deferred: GraphItem[] = [];
      for (const node of pending) {
        if (node.id === this.rootId) continue;
        const p = node.parentReference?.id;
        if (!p || !paths.has(p)) {
          deferred.push(node);
          continue;
        }
        const path = join(paths.get(p)!, node.name);
        paths.set(node.id, path);
        result.push({
          path,
          id: node.id,
          folder: !!node.folder,
          version: node.folder ? "" : (node.cTag ?? node.eTag ?? ""),
          tag: node.eTag,
          modifiedAt: graphTime(node),
        });
      }
      if (deferred.length === pending.length) break;
      pending = deferred;
    }
    return result.filter(
      (e) => !e.path.split("/").some((p) => p.startsWith(".")),
    );
  }
  async snapshot(): Promise<Entry[]> {
    await this.root();
    let next: string | undefined = this.delta ?? "/me/drive/root/delta";
    const nodes = new Map(this.nodes);
    let delta: string | undefined;
    try {
      while (next) {
        const page: GraphPage = await this.api(next);
        for (const node of page.value) {
          if (node.deleted || node["@removed"]) nodes.delete(node.id);
          else nodes.set(node.id, node);
        }
        next = page["@odata.nextLink"];
        delta = page["@odata.deltaLink"] ?? delta;
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 410 || !this.delta)
        throw error;
      this.delta = undefined;
      this.nodes.clear();
      return this.snapshot();
    }
    if (!delta) throw new Error("OneDrive returned no delta checkpoint.");
    this.nodes = nodes;
    this.delta = delta;
    return this.entries();
  }
  async downloadBytes(entry: Entry): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await (await this.fetchContent(entry)).arrayBuffer());
  }
  private async fetchContent(entry: Entry): Promise<Response> {
    const node = await this.api<GraphItem>(
      `/me/drive/items/${encodeURIComponent(entry.id)}`,
    );
    const url = node["@microsoft.graph.downloadUrl"];
    if (!url || !downloadHost(url))
      throw new Error(
        "OneDrive returned a download address MarkNotes does not trust.",
      );
    const r = await request(url);
    if (!r.ok) throw new ApiError(r.status, "OneDrive download");
    return r;
  }
  private itemEntry(node: GraphItem, path: string): Entry {
    this.nodes.set(node.id, node);
    return {
      path,
      id: node.id,
      folder: !!node.folder,
      version: node.folder ? "" : (node.cTag ?? node.eTag ?? ""),
      tag: node.eTag,
      modifiedAt: graphTime(node),
    };
  }
  async upload(
    path: string,
    content: Content,
    previous?: Entry,
    modifiedAt?: number,
  ): Promise<Entry> {
    await ensureParents(this, path);
    const root = await this.root();
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    if (previous && !previous.tag)
      throw new Error(
        "OneDrive omitted the revision guard; sync again before writing.",
      );
    const url = previous
      ? `/me/drive/items/${encodeURIComponent(previous.id)}/content`
      : `/me/drive/items/${encodeURIComponent(root)}:/${encoded}:/content?@microsoft.graph.conflictBehavior=fail`;
    let item = await this.api<GraphItem>(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(previous ? { "If-Match": previous.tag! } : {}),
      },
      body: encode(content),
    });
    if (modifiedAt !== undefined) {
      // Preserve the edit time so other devices can tell which version is newest.
      if (!item.eTag)
        throw new Error(
          "OneDrive omitted the revision guard; the edit time could not be saved safely.",
        );
      item = await this.api<GraphItem>(
        `/me/drive/items/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "If-Match": item.eTag,
          },
          body: JSON.stringify({
            fileSystemInfo: {
              lastModifiedDateTime: new Date(modifiedAt).toISOString(),
            },
          }),
        },
      );
      if (graphTime(item) !== modifiedAt)
        throw new Error(
          "OneDrive did not preserve the content edit time; sync again.",
        );
    }
    return this.itemEntry(item, path);
  }
  async mkdir(path: string): Promise<Entry> {
    const p = parent(path);
    const id = p ? (await this.ensureFolder(p)).id : await this.root();
    const node = await this.api<GraphItem>(
      `/me/drive/items/${encodeURIComponent(id)}/children`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: path.split("/").at(-1),
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      },
    );
    return this.itemEntry(node, path);
  }
  async ensureFolder(path: string): Promise<Entry> {
    let id = await this.root(),
      current = "",
      result: Entry | undefined;
    for (const part of path.split("/").filter(Boolean)) {
      current = join(current, part);
      const known = this.entries().find((e) => e.path === current && e.folder);
      if (known) {
        id = known.id;
        result = known;
        continue;
      }
      const node = await this.child(id, part);
      result = this.itemEntry(node, current);
      id = node.id;
    }
    if (!result) throw new Error("Missing folder path.");
    return result;
  }
  /** Deletes are conditional on the snapshot eTag; a newer revision fails with 412 and keeps the item. */
  async delete(entry: Entry): Promise<void> {
    if (entry.folder)
      throw new Error(
        "OneDrive cannot safely delete folders atomically without deleting unseen children; the folder and sync history were kept.",
      );
    if (!entry.tag)
      throw new Error(
        "OneDrive omitted the revision guard; sync again before deleting.",
      );
    try {
      await this.api(`/me/drive/items/${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
        headers: { "If-Match": entry.tag },
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    this.nodes.delete(entry.id);
  }
  async readManifest(): Promise<string | null> {
    try {
      const root = await this.root();
      const node = await this.api<GraphItem>(
        `/me/drive/items/${encodeURIComponent(root)}:/.marknotes/manifest.json`,
      );
      return await (
        await this.fetchContent({
          path: ".marknotes/manifest.json",
          id: node.id,
          folder: false,
          version: "",
        })
      ).text();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  async rename(entry: Entry, toPath: string): Promise<Entry> {
    if (
      entry.path === toPath ||
      foldCase(entry.path) !== foldCase(toPath) ||
      parent(entry.path) !== parent(toPath)
    )
      throw new Error("OneDrive sync rename must change only the name's case.");
    if (!entry.tag)
      throw new Error(
        "OneDrive omitted the revision guard; sync again before renaming.",
      );
    const item = await this.api<GraphItem>(
      `/me/drive/items/${encodeURIComponent(entry.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": entry.tag },
        body: JSON.stringify({
          name: toPath.split("/").at(-1),
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      },
    );
    if (item.id !== entry.id || item.name !== toPath.split("/").at(-1))
      throw new Error("OneDrive did not confirm the case rename; sync again.");
    return this.itemEntry(item, toPath);
  }
  async writeManifest(text: string): Promise<void> {
    const folder = await this.ensureFolder(".marknotes");
    await this.api(
      `/me/drive/items/${encodeURIComponent(folder.id)}:/manifest.json:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new TextEncoder().encode(text),
      },
    );
  }
  async folders(path: string): Promise<CloudFolder[]> {
    let next: string | undefined = `${this.path(path)}/children`;
    const folders: CloudFolder[] = [];
    while (next) {
      const page: GraphPage = await this.api(next);
      folders.push(
        ...page.value
          .filter((n) => n.folder)
          .map((n) => ({ path: join(path, n.name), name: n.name })),
      );
      next = page["@odata.nextLink"];
    }
    return folders;
  }
}
export function drive(auth: Auth, account: Account): Drive {
  return account.provider === "dropbox"
    ? new Dropbox(auth, account)
    : new OneDrive(auth, account);
}
