import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store, Vault, type Account } from "../js/storage";
import { Auth } from "../js/auth";
import { Dropbox, OneDrive } from "../js/providers";
let store: Store, auth: Auth, calls: { url: string; init: RequestInit }[];
const dbAccount: Account = {
  id: "db",
  provider: "dropbox",
  subject: "user",
  label: "user",
  folder: "MarkNotes",
};
const msAccount: Account = { ...dbAccount, id: "ms", provider: "onedrive" };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
beforeEach(async () => {
  store = await Store.open(crypto.randomUUID());
  calls = [];
  const vault = new Vault(store);
  for (const id of ["db", "ms"])
    await vault.save(id, { access: "token", expires: Date.now() + 3600000 });
  auth = new Auth(store, { dropbox: "public", onedrive: "public" });
});
afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
});
function mock(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}
describe("Dropbox store", () => {
  it("paginates snapshots, preserves case and uses conditional revision uploads", async () => {
    const item = {
      ".tag": "file",
      path_display: "/MarkNotes/Note.md",
      path_lower: "/marknotes/note.md",
      id: "id:file",
      rev: "r1",
      client_modified: "2024-01-02T03:04:05Z",
      server_modified: "2024-01-03T00:00:00Z",
    };
    mock((url, init) => {
      if (url.endsWith("create_folder_v2"))
        return json({
          metadata: {
            ".tag": "folder",
            path_display: "/MarkNotes",
            path_lower: "/marknotes",
            id: "folder",
          },
        });
      if (url.endsWith("list_folder"))
        return json({ entries: [item], cursor: "first", has_more: true });
      if (url.endsWith("list_folder/continue"))
        return json({ entries: [], cursor: "last", has_more: false });
      if (url.endsWith("upload")) {
        const arg = JSON.parse(
          new Headers(init.headers).get("Dropbox-API-Arg")!,
        );
        expect(arg.mode).toEqual({ ".tag": "update", update: "r1" });
        expect(arg.autorename).toBe(false);
        expect(arg.client_modified).toBe("2023-11-14T22:13:20Z");
        return json({ ...item, rev: "r2" });
      }
      throw new Error(`Unexpected ${url}`);
    });
    const remote = new Dropbox(auth, dbAccount);
    const entries = await remote.snapshot();
    expect(entries[0].path).toBe("Note.md");
    expect(entries[0].modifiedAt).toBe(Date.parse("2024-01-02T03:04:05Z"));
    expect(
      (await remote.upload("Note.md", "new", entries[0], 1700000000123))
        .version,
    ).toBe("r2");
    await remote.snapshot();
    expect(
      calls.filter((c) => c.url.endsWith("list_folder/continue")).at(-1)?.init
        .body,
    ).toBe('{"cursor":"last"}');
  });
  it("does not expose partially fetched pages on an error", async () => {
    mock((url) => {
      if (url.endsWith("create_folder_v2"))
        return json({
          metadata: {
            ".tag": "folder",
            path_display: "/MarkNotes",
            path_lower: "/marknotes",
            id: "folder",
          },
        });
      if (url.endsWith("list_folder"))
        return json({ entries: [], cursor: "page1", has_more: true });
      return json({}, 500);
    });
    await expect(new Dropbox(auth, dbAccount).snapshot()).rejects.toThrow(
      "500",
    );
  });
  it("deletes files only at the snapshot revision", async () => {
    const args: unknown[] = [];
    mock((url, init) => {
      const arg = JSON.parse(String(init.body)) as { path: string };
      args.push(arg);
      if (arg.path === "id:changed")
        return json({ error_summary: "path_write/conflict/file/.." }, 409);
      if (arg.path === "id:gone")
        return json({ error_summary: "path_lookup/not_found/.." }, 409);
      expect(url).toMatch(/delete_v2$/);
      return json({ metadata: {} });
    });
    const remote = new Dropbox(auth, dbAccount);
    const file = { path: "N.md", id: "id:file", folder: false, version: "r1" };
    await remote.delete(file);
    await remote.delete({ path: "F", id: "id:dir", folder: true, version: "" });
    await remote.delete({ ...file, id: "id:gone" });
    expect(args.slice(0, 2)).toEqual([
      { path: "id:file", parent_rev: "r1" },
      { path: "id:dir" },
    ]);
    await expect(remote.delete({ ...file, id: "id:changed" })).rejects.toThrow(
      "409",
    );
    await expect(remote.delete({ ...file, version: "" })).rejects.toThrow(
      "revision guard",
    );
  });
  it("reads the server time when the client time is missing", async () => {
    mock((url) => {
      if (url.endsWith("create_folder_v2"))
        return json({
          metadata: { ".tag": "folder", path_lower: "/marknotes", id: "f" },
        });
      return json({
        entries: [
          {
            ".tag": "file",
            path_lower: "/marknotes/n.md",
            id: "id:n",
            rev: "r1",
            server_modified: "2024-01-03T00:00:00Z",
          },
        ],
        cursor: "c",
        has_more: false,
      });
    });
    const [entry] = await new Dropbox(auth, dbAccount).snapshot();
    expect(entry?.modifiedAt).toBe(Date.parse("2024-01-03T00:00:00Z"));
  });
});
describe("OneDrive store", () => {
  it("handles delta parent ordering, case, cTag and guarded updates", async () => {
    mock((url, init) => {
      if (url.endsWith("/me/drive/root"))
        return json({ id: "drive", name: "root", folder: {} });
      if (url.endsWith("drive:/MarkNotes"))
        return json({
          id: "sync",
          name: "MarkNotes",
          folder: {},
          parentReference: { id: "drive" },
        });
      if (url.endsWith("/root/delta") || url.endsWith("/checkpoint"))
        return json({
          value: [
            {
              id: "note",
              name: "N.md",
              cTag: "c1",
              eTag: "e1",
              lastModifiedDateTime: "2024-01-03T00:00:00Z",
              fileSystemInfo: { lastModifiedDateTime: "2024-01-02T03:04:05Z" },
              parentReference: { id: "folder" },
            },
            {
              id: "folder",
              name: "Folder",
              folder: {},
              parentReference: { id: "sync" },
            },
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/checkpoint",
        });
      if (url.endsWith("/note/content")) {
        expect(new Headers(init.headers).get("If-Match")).toBe("e1");
        return json({
          id: "note",
          name: "N.md",
          cTag: "c2",
          eTag: "e2",
          parentReference: { id: "folder" },
        });
      }
      if (url.endsWith("/me/drive/items/note") && init.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({
          fileSystemInfo: { lastModifiedDateTime: "2023-11-14T22:13:20.123Z" },
        });
        return json({
          id: "note",
          name: "N.md",
          cTag: "c2",
          eTag: "e3",
          fileSystemInfo: { lastModifiedDateTime: "2023-11-14T22:13:20.123Z" },
          parentReference: { id: "folder" },
        });
      }
      throw new Error(`Unexpected ${url}`);
    });
    const remote = new OneDrive(auth, msAccount);
    const entries = await remote.snapshot(),
      entry = entries.find((e) => e.path === "Folder/N.md")!;
    expect(entry.version).toBe("c1");
    expect(entry.tag).toBe("e1");
    expect(entry.modifiedAt).toBe(Date.parse("2024-01-02T03:04:05Z"));
    const updated = await remote.upload(
      entry.path,
      "new",
      entry,
      1700000000123,
    );
    expect(updated.version).toBe("c2");
    expect(updated.tag).toBe("e3");
    expect(updated.modifiedAt).toBe(1700000000123);
    await remote.snapshot();
    expect(calls.at(-1)?.url).toContain("/checkpoint");
  });
  describe("keeps no delta checkpoint after a failed full listing", () => {
    const file = (id: string) => ({
      id,
      name: `${id}.md`,
      cTag: id,
      parentReference: { id: "sync" },
    });
    function drive(fail: () => boolean, expired = false) {
      mock((url) => {
        if (url.endsWith("/me/drive/root")) return json({ id: "drive" });
        if (url.endsWith("drive:/MarkNotes"))
          return json({ id: "sync", folder: {} });
        if (url.endsWith("/root/delta"))
          return json({
            value: [file("a")],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2",
          });
        if (url.endsWith("/page2"))
          return fail()
            ? json({ error: { code: "generalException" } }, 500)
            : json({
                value: [file("b")],
                "@odata.deltaLink":
                  "https://graph.microsoft.com/v1.0/checkpoint",
              });
        if (url.endsWith("/checkpoint"))
          return expired
            ? json({ error: { code: "resyncRequired" } }, 410)
            : json({ value: [] });
        throw new Error(`Unexpected ${url}`);
      });
    }
    const deltaCalls = () =>
      calls
        .map((c) => c.url)
        .filter((u) => /\/(root\/delta|page2|checkpoint)$/.test(u));
    it("lists everything again after a page fails mid-traversal", async () => {
      let failures = 1;
      drive(() => failures-- > 0);
      const remote = new OneDrive(auth, msAccount);
      await expect(remote.snapshot()).rejects.toThrow("500");
      calls = [];
      const entries = await remote.snapshot();
      expect(deltaCalls()[0]).toMatch(/\/me\/drive\/root\/delta$/);
      expect(deltaCalls().some((u) => u.endsWith("/checkpoint"))).toBe(false);
      expect(entries.map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
    });
    it("lists everything again after a failed resync", async () => {
      let failures = 0;
      drive(() => failures-- > 0, true);
      const remote = new OneDrive(auth, msAccount);
      await remote.snapshot();
      failures = 1;
      await expect(remote.snapshot()).rejects.toThrow("500");
      calls = [];
      const entries = await remote.snapshot();
      expect(deltaCalls()[0]).toMatch(/\/me\/drive\/root\/delta$/);
      expect(entries.map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
    });
  });
  it("deletes only at the snapshot eTag and keeps a changed item", async () => {
    mock((_url, init) => {
      const tag = new Headers(init.headers).get("If-Match");
      return tag === "e1"
        ? new Response(null, { status: 204 })
        : json({ error: { code: "notAllowed" } }, 412);
    });
    const remote = new OneDrive(auth, msAccount);
    const file = { path: "N.md", id: "n", folder: false, version: "c1" };
    await remote.delete({ ...file, tag: "e1" });
    expect(calls[0]?.init.method).toBe("DELETE");
    await expect(remote.delete({ ...file, tag: "e0" })).rejects.toThrow("412");
    await expect(remote.delete(file)).rejects.toThrow("revision guard");
  });
  it("never forwards Graph bearer tokens to preauthenticated download URLs", async () => {
    mock((url, init) => {
      if (url.includes("graph.microsoft.com"))
        return json({
          id: "note",
          "@microsoft.graph.downloadUrl":
            "https://public.bn.files.1drv.com/note",
        });
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      return new Response("private note");
    });
    const bytes = await new OneDrive(auth, msAccount).downloadBytes({
      id: "note",
      path: "N.md",
      folder: false,
      version: "",
    });
    expect(new TextDecoder().decode(bytes)).toBe("private note");
  });
  it("downloads only from Microsoft content hosts", async () => {
    for (const [url, ok] of [
      ["https://my.microsoftpersonalcontent.com/x", true],
      ["https://contoso-my.sharepoint.com/x", true],
      ["https://download.example.invalid/x", false],
      ["https://1drv.com.attacker.invalid/x", false],
      ["http://public.bn.files.1drv.com/x", false],
    ] as const) {
      mock((u) =>
        new URL(u).hostname === "graph.microsoft.com"
          ? json({ id: "n", "@microsoft.graph.downloadUrl": url })
          : new Response("ok"),
      );
      const download = new OneDrive(auth, msAccount).downloadBytes({
        id: "n",
        path: "N.md",
        folder: false,
        version: "",
      });
      if (ok) await expect(download).resolves.toBeDefined();
      else await expect(download).rejects.toThrow("does not trust");
    }
  });
  it("rejects a continuation URL outside Microsoft Graph", async () => {
    mock((url) =>
      url.endsWith("/root")
        ? json({ id: "root", folder: {} })
        : url.endsWith("root:/MarkNotes")
          ? json({ id: "sync", folder: {} })
          : json({
              value: [],
              "@odata.nextLink": "https://attacker.invalid/steal",
            }),
    );
    await expect(new OneDrive(auth, msAccount).snapshot()).rejects.toThrow(
      "Untrusted",
    );
    expect(calls.some((c) => c.url.includes("attacker"))).toBe(false);
  });
});
