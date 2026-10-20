import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, Vault, validateName, validatePath } from "../js/storage";

let store: Store;
beforeEach(async () => {
  store = await Store.open(crypto.randomUUID());
});
afterEach(() => store.close());
describe("browser note tree", () => {
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
  it("rejects collisions and stale writes without replacing data", async () => {
    const first = await store.write("n.md", "one");
    await store.write("n.md", "two", first.revision);
    await expect(store.write("n.md", "stale", first.revision)).rejects.toThrow(
      "another tab",
    );
    expect((await store.note("n.md"))?.text).toBe("two");
    await expect(store.create("n.md", false)).rejects.toThrow("already exists");
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
