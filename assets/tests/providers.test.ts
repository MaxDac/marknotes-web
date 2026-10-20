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
        return json({ ...item, rev: "r2" });
      }
      throw new Error(`Unexpected ${url}`);
    });
    const remote = new Dropbox(auth, dbAccount);
    const entries = await remote.snapshot();
    expect(entries[0].path).toBe("Note.md");
    expect((await remote.upload("Note.md", "new", entries[0])).version).toBe(
      "r2",
    );
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
      throw new Error(`Unexpected ${url}`);
    });
    const remote = new OneDrive(auth, msAccount);
    const entries = await remote.snapshot(),
      entry = entries.find((e) => e.path === "Folder/N.md")!;
    expect(entry.version).toBe("c1");
    expect(entry.tag).toBe("e1");
    expect((await remote.upload(entry.path, "new", entry)).version).toBe("c2");
    await remote.snapshot();
    expect(calls.at(-1)?.url).toContain("/checkpoint");
  });
  it("never forwards Graph bearer tokens to preauthenticated download URLs", async () => {
    mock((url, init) => {
      if (url.includes("graph.microsoft.com"))
        return json({
          id: "note",
          "@microsoft.graph.downloadUrl":
            "https://download.example.invalid/note",
        });
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      return new Response("private note");
    });
    expect(
      await new OneDrive(auth, msAccount).download({
        id: "note",
        path: "N.md",
        folder: false,
        version: "",
      }),
    ).toBe("private note");
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
