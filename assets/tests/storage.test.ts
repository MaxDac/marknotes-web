import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exclusive,
  Store,
  Vault,
  validateName,
  validatePath,
} from "../js/storage";
import { MemoryBackend } from "../js/backend";

let store: Store;
beforeEach(async () => {
  store = await Store.open(crypto.randomUUID());
});
afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
});
describe("note tree locking", () => {
  it("runs queued work under the default exclusive lock", async () => {
    const request = vi.fn(
      async (
        name: string,
        _options: LockOptions,
        work: LockGrantedCallback<unknown>,
      ) => work({ name, mode: "exclusive" }),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    await expect(exclusive(async () => 42)).resolves.toBe(42);
    expect(request).toHaveBeenCalledWith(
      "marknotes:tree",
      {},
      expect.any(Function),
    );
  });
  it("rejects unavailable interactive locks without running the action", async () => {
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        work: LockGrantedCallback<unknown>,
      ) => work(null),
    );
    const action = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { locks: { request } });
    await expect(exclusive(action, { ifAvailable: true })).rejects.toThrow(
      "Another MarkNotes tab",
    );
    expect(action).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "marknotes:tree",
      { ifAvailable: true },
      expect.any(Function),
    );
  });
});
describe("browser note tree", () => {
  it("atomically rejects occupied sync folders, including Unicode aliases and virtual attachments", async () => {
    await store.create("ſtuff", true);
    await expect(store.createSyncFolder("stuff")).rejects.toThrow(
      "already exists",
    );
    await store.createSyncFolder("attachments", "attachments-folder");
    await expect(
      store.createSyncFolder("attachments", "attachments-folder"),
    ).rejects.toThrow("already exists");
    expect(await store.value("attachments-folder")).toBe(true);
    expect(await store.note("stuff")).toBeUndefined();
  });
  it("requires absence atomically for new downloads and does not create aliased parents", async () => {
    await store.write("n.md", "new user edit");
    await expect(store.write("n.md", "download", null)).rejects.toThrow(
      "changed",
    );
    expect((await store.note("n.md"))?.text).toBe("new user edit");
    await store.create("ſtuff", true);
    await expect(store.write("stuff/n.md", "download", null)).rejects.toThrow(
      "Another spelling",
    );
    expect(await store.note("stuff")).toBeUndefined();
    await store.write("new.md", "download", null);
    expect((await store.note("new.md"))?.text).toBe("download");
  });
  it("persists exact UTF-8/newlines and creates parent folders", async () => {
    await store.write("folder/note.MD", "café\r\nnext\n");
    expect((await store.note("folder/note.MD"))?.text).toBe("café\r\nnext\n");
    expect((await store.note("folder"))?.folder).toBe(true);
  });
  it("atomically moves subtrees and leaves sync history under old paths", async () => {
    await store.write("one/n.md", "note");
    await store.put("drive:records", [{ path: "one/n.md" }]);
    await store.move("one", "two");
    expect((await store.note("two/n.md"))?.text).toBe("note");
    expect(await store.note("one")).toBeUndefined();
    expect(await store.value("drive:records")).toEqual([{ path: "one/n.md" }]);
    await expect(store.move("two", "two/child")).rejects.toThrow(
      "inside itself",
    );
  });
  it("atomically stages a copy and retry intent without overwriting a racing note", async () => {
    const copy = { path: "copy.md", text: "loser", modifiedAt: 1234 };
    await store.stageSyncCopy("a:copy-intents", ["intent"], copy, false);
    expect(await store.value("a:copy-intents")).toEqual(["intent"]);
    expect((await store.note(copy.path))?.modifiedAt).toBe(1234);
    await expect(
      store.stageSyncCopy(
        "a:copy-intents",
        ["new"],
        { ...copy, text: "other" },
        false,
      ),
    ).rejects.toThrow("conflicted copy changed");
    expect(await store.value("a:copy-intents")).toEqual(["intent"]);
    expect((await store.note(copy.path))?.text).toBe("loser");
    await store.stageSyncCopy("a:copy-intents", ["retry"], copy, true);
    expect(await store.value("a:copy-intents")).toEqual(["retry"]);
  });
  it("renames sync subtrees atomically, preserves edit times and remaps only one drive's history", async () => {
    await store.write("Folder/Note.md", "text", undefined, 1234);
    const records = [
      {
        path: "Folder/Note.md",
        folder: false,
        remoteId: "id",
        version: "v1",
        hash: "hash",
        syncedAt: 5000,
      },
    ];
    await store.put("a:records", records);
    await store.put("b:records", records);
    await store.putBase("a", "Folder/Note.md", "base");
    await store.putBase("b", "Folder/Note.md", "other base");
    const expected = await store.list();
    const renamed = records.map((r) => ({ ...r, path: "folder/Note.md" }));
    await store.commitSyncRename("a", "Folder", "folder", renamed, expected);
    expect((await store.note("folder/Note.md"))?.modifiedAt).toBe(1234);
    expect(await store.note("Folder/Note.md")).toBeUndefined();
    expect(await store.value("a:records")).toEqual(renamed);
    expect(await store.base("a", "folder/Note.md")).toBe("base");
    expect(await store.base("a", "Folder/Note.md")).toBeUndefined();
    expect(await store.value("b:records")).toEqual(records);
    expect(await store.base("b", "Folder/Note.md")).toBe("other base");
  });
  it("does not expose a copy or journal when encrypted backend persistence fails", async () => {
    const locked = new Store(
      new MemoryBackend(async () => {
        throw new Error("encrypted persistence failed");
      }),
    );
    await expect(
      locked.stageSyncCopy(
        "a:copy-intents",
        ["intent"],
        { path: "copy.md", text: "loser", modifiedAt: 0 },
        false,
      ),
    ).rejects.toThrow("encrypted persistence failed");
    expect(await locked.note("copy.md")).toBeUndefined();
    expect(await locked.value("a:copy-intents")).toBeUndefined();
    locked.close();
  });
  it("uses shared Unicode folding for atomic no-clobber copy creation", async () => {
    await store.write("s (conflicted copy).md", "occupied", undefined, 1000);
    await expect(
      store.stageSyncCopy(
        "a:copy-intents",
        ["intent"],
        { path: "\u017f (conflicted copy).md", text: "new", modifiedAt: 1000 },
        false,
      ),
    ).rejects.toThrow("another spelling");
    expect(await store.value("a:copy-intents")).toBeUndefined();
    expect((await store.note("s (conflicted copy).md"))?.text).toBe("occupied");
  });
  it("verifies a metadata-only rename target without rewriting its note", async () => {
    await store.write("note.md", "one", undefined, 1234);
    await store.putBase("a", "Note.md", "base");
    const expected = await store.list();
    await store.commitSyncRename("a", "Note.md", "note.md", [], expected, true);
    expect(await store.note("note.md")).toEqual(expected[0]);
    expect(await store.base("a", "note.md")).toBe("base");
    expect(await store.base("a", "Note.md")).toBeUndefined();
  });
  it("rejects concurrent edits and collisions during sync renames without migrating history", async () => {
    await store.write("Note.md", "old", undefined, 1000);
    const expected = await store.list();
    await store.write("Note.md", "edited", undefined, 2000);
    await expect(
      store.commitSyncRename("a", "Note.md", "note.md", [], expected),
    ).rejects.toThrow("changed while renaming");
    const current = await store.list();
    await store.write("note.md", "occupied", undefined, 3000);
    await expect(
      store.commitSyncRename("a", "Note.md", "note.md", [], current),
    ).rejects.toThrow("destination already exists");
    expect((await store.note("Note.md"))?.text).toBe("edited");
    expect((await store.note("note.md"))?.text).toBe("occupied");
    expect(await store.value("a:records")).toBeUndefined();
  });
  it("never recursively deletes an unplanned local child", async () => {
    await store.write("folder/ignored.txt.md", "preserve");
    await expect(store.deleteEmptyFolder("folder")).rejects.toThrow(
      "not empty",
    );
    expect((await store.note("folder/ignored.txt.md"))?.text).toBe("preserve");
    await store.delete("folder/ignored.txt.md");
    await store.deleteEmptyFolder("folder");
    expect(await store.note("folder")).toBeUndefined();
  });
  it("rejects collisions and stale writes without replacing data", async () => {
    const first = await store.write("n.md", "one");
    await store.write("n.md", "two", first.revision);
    await expect(store.write("n.md", "stale", first.revision)).rejects.toThrow(
      "another tab",
    );
    expect((await store.note("n.md"))?.text).toBe("two");
    await expect(store.create("n.md", false)).rejects.toThrow("already exists");
  });
  it("creates notes with initial text", async () => {
    await store.create("song.md", false, "---\nid: abc\ntype: chords\n---\n");
    expect((await store.note("song.md"))?.text).toBe(
      "---\nid: abc\ntype: chords\n---\n",
    );
  });
  it("deletes an entire subtree but keeps unrelated notes", async () => {
    await store.write("a/n.md", "n");
    await store.write("b.md", "b");
    await store.delete("a");
    expect((await store.list()).map((n) => n.path)).toEqual(["b.md"]);
  });
  it("rejects a stale editor after a path is deleted and recreated", async () => {
    const old = await store.write("n.md", "old");
    await store.delete("n.md");
    await store.write("n.md", "recreated");
    await expect(store.write("n.md", "stale", old.revision)).rejects.toThrow(
      "another tab",
    );
    expect((await store.note("n.md"))?.text).toBe("recreated");
  });
  it("rejects hidden, absolute and traversal paths", () => {
    for (const path of [
      "/a.md",
      "../a.md",
      ".marknotes/n.md",
      "a//b.md",
      " a.md",
      "a\\b.md",
    ])
      expect(() => validatePath(path)).toThrow();
    expect(() => validateName("ok.md")).not.toThrow();
  });
  it("keeps a stable device ID and forgets only the selected account", async () => {
    expect(await store.deviceId()).toBe(await store.deviceId());
    await store.saveAccount({
      id: "a",
      label: "a",
      subject: "a",
      provider: "dropbox",
      folder: "",
    });
    await store.saveAccount({
      id: "b",
      label: "b",
      subject: "b",
      provider: "onedrive",
      folder: "",
    });
    await store.put("a:records", []);
    await store.put("b:records", ["keep"]);
    await store.forgetAccount("a");
    expect((await store.accounts()).map((a) => a.id)).toEqual(["b"]);
    expect(await store.value("a:records")).toBeUndefined();
    expect(await store.value("b:records")).toEqual(["keep"]);
  });
});
describe("credential vault", () => {
  it("stores authenticated ciphertext with a non-extractable key and fresh IVs", async () => {
    const vault = new Vault(store);
    await vault.save("a", { token: "private-token" });
    const first = await store.value<{ iv: Uint8Array; bytes: ArrayBuffer }>(
      "a:credentials",
    );
    expect(await vault.load("a")).toEqual({ token: "private-token" });
    const key = await store.value<CryptoKey>("vault-key");
    expect(key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key!)).rejects.toThrow();
    await vault.save("a", { token: "private-token" });
    expect(
      (await store.value<{ iv: Uint8Array }>("a:credentials"))?.iv,
    ).not.toEqual(first?.iv);
    expect(new TextDecoder().decode(first!.bytes)).not.toContain(
      "private-token",
    );
  });
  it("does not silently replace a missing key", async () => {
    const vault = new Vault(store);
    await vault.save("a", "token");
    await store.remove("vault-key");
    await expect(vault.load("a")).rejects.toThrow("key is missing");
  });
});

describe("note ids and attachments storage", () => {
  it("creates notes with an id and lazily assigns missing or duplicate ids", async () => {
    await store.create("New.md", false);
    expect((await store.note("New.md"))?.text).toMatch(
      /^---\nid: [0-9a-z]{8}\n---\n$/,
    );
    await store.write("A.md", "---\nid: same1111\nkeep: 1\n---\nA");
    await store.write("B.md", "---\nid: same1111\n---\nB");
    await store.write("Legacy.md", "legacy body");
    expect(await store.assignIds(["A.md"])).toEqual([]);
    expect(await store.assignIds(["Legacy.md"])).toEqual(["Legacy.md"]);
    expect((await store.note("Legacy.md"))?.text).toMatch(
      /^---\nid: [0-9a-z]{8}\n---\nlegacy body$/,
    );
    expect(await store.assignIds()).toEqual(["B.md"]);
    expect((await store.note("A.md"))?.text).toBe(
      "---\nid: same1111\nkeep: 1\n---\nA",
    );
    expect((await store.note("B.md"))?.text).not.toContain("same1111");
    expect(await store.assignIds()).toEqual([]);
  });
  it("reserves the root attachments folder", async () => {
    await expect(store.create("attachments", true)).rejects.toThrow("reserved");
    await store.write("n.md", "x");
    await expect(store.move("n.md", "attachments/n.md")).rejects.toThrow(
      "reserved",
    );
  });
  it("stores attachment bytes separately from notes", async () => {
    const path = `attachments/${"a".repeat(64)}.png`;
    await store.putAttachment(path, new Uint8Array([1, 2, 3]));
    expect((await store.attachment(path))?.bytes).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await store.attachmentPaths()).toEqual([path]);
    expect(await store.list()).toEqual([]);
    await store.deleteAttachment(path);
    expect(await store.attachments()).toEqual([]);
  });
  it("upgrades version 1 databases without losing notes", async () => {
    const name = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("notes", { keyPath: "path" }).put({
          path: "old.md",
          folder: false,
          text: "kept",
          revision: "r",
        });
        db.createObjectStore("values");
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const upgraded = await Store.open(name);
    expect((await upgraded.note("old.md"))?.text).toBe("kept");
    expect(await upgraded.attachments()).toEqual([]);
    upgraded.close();
  });
});
