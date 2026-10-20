import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type Account } from "../js/storage";
import { SyncEngine, syncAll } from "../js/sync";
import { FakeDrive } from "./fake-drive";
let store: Store, remote: FakeDrive, engine: SyncEngine;
const account: Account = {
  id: "a",
  provider: "dropbox",
  subject: "a",
  label: "test",
  folder: "MarkNotes",
};
beforeEach(async () => {
  store = await Store.open(crypto.randomUUID());
  remote = new FakeDrive();
  engine = new SyncEngine(store, account, remote);
});
afterEach(() => store.close());
describe("sync decision matrix", () => {
  it("uploads local notes/folders and publishes Android format-1 metadata", async () => {
    await store.write("folder/n.md", "hello\n");
    expect((await engine.run()).errors).toEqual([]);
    expect(remote.data.get("folder/n.md")?.text).toBe("hello\n");
    const m = JSON.parse(remote.manifest!);
    expect(m.format).toBe(1);
    expect(m.app).toBe("MarkNotes");
    expect(m.files["folder/n.md"].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.files["folder/n.md"].version).toBe(
      remote.data.get("folder/n.md")?.entry.version,
    );
    expect(typeof m.updatedAt).toBe("number");
    await engine.run();
    expect(remote.writes).toBe(1);
  });
  it("downloads initial remote content and ignores non-Markdown/hidden files", async () => {
    await remote.edit("n.MD", "remote");
    await remote.edit("image.png", "image");
    await remote.edit(".hidden.md", "hidden");
    await engine.run();
    expect((await store.list()).map((n) => n.path)).toEqual(["n.MD"]);
  });
  it("propagates local and remote revisions", async () => {
    await store.write("n.md", "one");
    await engine.run();
    await store.write("n.md", "two");
    await engine.run();
    expect(remote.data.get("n.md")?.text).toBe("two");
    await remote.edit("n.md", "three");
    await engine.run();
    expect((await store.note("n.md"))?.text).toBe("three");
  });
  it("propagates deletion only when the other side is unchanged", async () => {
    await store.write("n.md", "one");
    await engine.run();
    await store.delete("n.md");
    await engine.run();
    expect(remote.data.has("n.md")).toBe(false);
    await store.write("n.md", "new");
    await engine.run();
    remote.data.delete("n.md");
    await engine.run();
    expect(await store.note("n.md")).toBeUndefined();
  });
  it("lets edited content survive an opposing deletion", async () => {
    await store.write("n.md", "one");
    await engine.run();
    await store.delete("n.md");
    await remote.edit("n.md", "changed remotely");
    await engine.run();
    expect((await store.note("n.md"))?.text).toBe("changed remotely");
    remote.data.delete("n.md");
    await store.write("n.md", "changed locally");
    await engine.run();
    expect(remote.data.get("n.md")?.text).toBe("changed locally");
  });
  it("preserves modified descendants when their remote folder disappears", async () => {
    await store.write("folder/a.md", "one");
    await engine.run();
    await remote.delete(remote.data.get("folder")!.entry);
    await store.write("folder/a.md", "local edit");
    await engine.run();
    expect(remote.data.get("folder/a.md")?.text).toBe("local edit");
  });
  it("deletes unchanged folder subtrees", async () => {
    await store.write("folder/a.md", "one");
    await engine.run();
    await store.delete("folder");
    await engine.run();
    expect(remote.data.size).toBe(0);
  });
  it("merges disjoint edits and retains overlapping conflicts until resolved", async () => {
    await store.write("n.md", "a\nb\nc\n");
    await engine.run();
    await store.write("n.md", "A\nb\nc\n");
    await remote.edit("n.md", "a\nb\nC\n");
    expect((await engine.run()).conflicts).toHaveLength(0);
    expect((await store.note("n.md"))?.text).toBe("A\nb\nC\n");
    await store.write("n.md", "mine");
    await remote.edit("n.md", "theirs");
    const conflict = (await engine.run()).conflicts[0];
    expect(conflict).toBeDefined();
    expect((await engine.run()).conflicts).toHaveLength(1);
    await engine.resolve(conflict, "resolved");
    expect((await store.note("n.md"))?.text).toBe("resolved");
    expect(remote.data.get("n.md")?.text).toBe("resolved");
  });
  it("reports different initial versions rather than overwriting", async () => {
    await store.write("n.md", "mine");
    await remote.edit("n.md", "theirs");
    const result = await engine.run();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].base).toBeNull();
  });
  it("rejects stale resolution and supports unique conflicted siblings", async () => {
    await store.write("n.md", "mine");
    await remote.edit("n.md", "theirs");
    const conflict = (await engine.run()).conflicts[0];
    await store.write("n.md", "new edit");
    await expect(engine.resolve(conflict, "old")).rejects.toThrow(
      "changed since",
    );
    const current = (await engine.run()).conflicts[0];
    await engine.resolve(current, current.mine, true);
    expect((await store.note("n (conflicted copy).md"))?.text).toBe("theirs");
    expect(remote.data.get("n.md")?.text).toBe("new edit");
  });
  it("never interprets a failed snapshot as remote deletion", async () => {
    await store.write("n.md", "keep");
    await engine.run();
    remote.fail = true;
    await expect(engine.run()).rejects.toThrow("Unavailable");
    expect((await store.note("n.md"))?.text).toBe("keep");
  });
  it("matches Android's conflict sibling counter and extension casing", async () => {
    await store.write("n.MD", "mine");
    await store.write("n (conflicted copy).MD", "existing");
    await remote.edit("n.MD", "theirs");
    const conflict = (await engine.run()).conflicts.find(
      (c) => c.path === "n.MD",
    )!;
    await engine.resolve(conflict, conflict.mine, true);
    expect((await store.note("n (conflicted copy) 2.MD"))?.text).toBe("theirs");
    expect((await store.note("n (conflicted copy).MD"))?.text).toBe("existing");
  });
  it("reports corrupt manifests but still syncs from content", async () => {
    remote.manifest = "{bad";
    await remote.edit("n.md", "remote");
    expect((await engine.run()).errors[0]).toContain("Manifest");
    expect((await store.note("n.md"))?.text).toBe("remote");
  });
  it("rejects malformed manifest file entries without skipping note sync", async () => {
    remote.manifest = JSON.stringify({ format: 1, files: { "n.md": null } });
    await remote.edit("n.md", "remote");
    const result = await engine.run();
    expect(result.errors[0]).toContain("Manifest");
    expect((await store.note("n.md"))?.text).toBe("remote");
  });
  it("requeues other drives after downloads", async () => {
    const second = new FakeDrive();
    await second.edit("new.md", "second");
    const result = await syncAll(store, [
      { account, remote },
      { account: { ...account, id: "b" }, remote: second },
    ]);
    expect([...result.values()].flatMap((r) => r.errors)).toEqual([]);
    expect(remote.data.get("new.md")?.text).toBe("second");
  });
});
