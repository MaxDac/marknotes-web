import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type Account } from "../js/storage";
import { SyncEngine, localTime, syncAll } from "../js/sync";
import { isChordSequence, parseChordBody } from "../js/chords";
import { noteBody } from "../js/notemeta";
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
  it("keeps the newer drive edit and saves the older local one as a copy", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await store.write("n.md", "mine", undefined, 2000);
    await remote.edit("n.md", "theirs", 3000);
    const result = await engine.run();
    expect(result.errors).toEqual([]);
    expect(result.copies).toEqual(["n (conflicted copy).md"]);
    const local = await store.note("n.md");
    expect(local?.text).toBe("theirs");
    expect(local?.modifiedAt).toBe(3000);
    expect(remote.data.get("n.md")?.text).toBe("theirs");
    expect((await store.note("n (conflicted copy).md"))?.text).toBe("mine");
    expect(remote.data.get("n (conflicted copy).md")?.text).toBe("mine");
    expect(remote.data.get("n (conflicted copy).md")?.entry.modifiedAt).toBe(
      2000,
    );
    expect((await engine.run()).copies).toEqual([]);
  });
  it("keeps the newer local edit and overwrites the drive", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await remote.edit("n.md", "theirs", 2000);
    await store.write("n.md", "mine", undefined, 3000);
    expect((await engine.run()).copies).toEqual(["n (conflicted copy).md"]);
    expect(remote.data.get("n.md")?.text).toBe("mine");
    expect(remote.data.get("n.md")?.entry.modifiedAt).toBe(3000);
    expect((await store.note("n.md"))?.text).toBe("mine");
    expect((await store.note("n (conflicted copy).md"))?.text).toBe("theirs");
  });
  it("reconciles differing initial versions by modification time", async () => {
    await store.write("n.md", "mine", undefined, 1000);
    await remote.edit("n.md", "theirs", 2000);
    expect((await engine.run()).copies).toHaveLength(1);
    expect((await store.note("n.md"))?.text).toBe("theirs");
    expect((await store.note("n (conflicted copy).md"))?.text).toBe("mine");
  });
  it("prefers the local version when modification times are equal", async () => {
    await store.write("n.md", "mine", undefined, 2000);
    await remote.edit("n.md", "theirs", 2000);
    await engine.run();
    expect(remote.data.get("n.md")?.text).toBe("mine");
    expect((await store.note("n (conflicted copy).md"))?.text).toBe("theirs");
  });
  it("gives conflicted copies their own id so links keep targeting the original", async () => {
    await store.write("n.md", "---\nid: orig1234\n---\nmine", undefined, 1000);
    await remote.edit("n.md", "---\nid: orig1234\n---\ntheirs", 2000);
    await engine.run();
    const copy = (await store.note("n (conflicted copy).md"))!.text;
    expect(copy).toMatch(/^---\nid: [0-9a-z]{8}\n---\nmine$/);
    expect(copy).not.toContain("orig1234");
    expect((await store.note("n.md"))?.text).toContain("orig1234");
    await store.write("n.md", "---\nid: orig1234\n---\nmine", undefined, 3000);
    await remote.edit("n.md", "---\nid: orig1234\n---\nnewest", 4000);
    expect((await engine.run()).copies).toEqual([]);
  });
  it("syncs chord sequences as ordinary notes and keeps their type on conflicted copies", async () => {
    const head = "---\nid: chord123\ntype: chords\n---\n";
    const mine = `${head}## C (guitar)\nfrets: x 3/3 2/2 0 1/1 0\n`;
    const theirs = `${head}## G (guitar)\nfrets: 3/2 2/1 0 0 0 3/3\n`;
    await store.write("song.md", mine, undefined, 1000);
    await engine.run();
    expect(remote.data.get("song.md")?.text).toBe(mine);
    await store.write("song.md", `${mine}\n`, undefined, 2000);
    await remote.edit("song.md", theirs, 3000);
    expect((await engine.run()).copies).toEqual(["song (conflicted copy).md"]);
    expect((await store.note("song.md"))?.text).toBe(theirs);
    const copy = (await store.note("song (conflicted copy).md"))!.text;
    expect(isChordSequence(copy)).toBe(true);
    expect(copy).not.toContain("chord123");
    expect(parseChordBody(noteBody(copy)).sequence?.chords[0]?.baseName).toBe(
      "C",
    );
  });
  it("does not duplicate an identical conflicted copy", async () => {
    await store.write("n.md", "mine", undefined, 1000);
    await remote.edit("n.md", "theirs", 2000);
    await engine.run();
    await store.write("n.md", "mine", undefined, 3000);
    await remote.edit("n.md", "newest", 4000);
    expect((await engine.run()).copies).toEqual([]);
    expect(await store.note("n (conflicted copy) 2.md")).toBeUndefined();
    expect((await store.note("n.md"))?.text).toBe("newest");
  });
  it("keeps remote edit times for downloaded notes", async () => {
    await remote.edit("n.md", "remote", 1234);
    await engine.run();
    expect((await store.note("n.md"))?.modifiedAt).toBe(1234);
  });
  it("falls back to the last sync time for notes saved before timestamps", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    const note = (await store.note("n.md"))!;
    // Simulate a note stored by a version without modifiedAt.
    const legacy = { ...note, text: "legacy edit", modifiedAt: undefined };
    expect(localTime(legacy, { syncedAt: 42 } as never)).toBe(42);
    expect(localTime(legacy)).toBe(0);
  });
  it("never interprets a failed snapshot as remote deletion", async () => {
    await store.write("n.md", "keep");
    await engine.run();
    remote.fail = true;
    await expect(engine.run()).rejects.toThrow("Unavailable");
    expect((await store.note("n.md"))?.text).toBe("keep");
  });
  it("matches Android's conflict sibling counter and extension casing", async () => {
    await store.write("n.MD", "mine", undefined, 1000);
    await store.write("n (conflicted copy).MD", "existing", undefined, 1000);
    await remote.edit("n.MD", "theirs", 2000);
    await engine.run();
    expect((await store.note("n (conflicted copy) 2.MD"))?.text).toBe("mine");
    expect((await store.note("n (conflicted copy).MD"))?.text).toBe("existing");
    expect((await store.note("n.MD"))?.text).toBe("theirs");
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
  for (const [first, second] of [
    [2000, 3000],
    [3000, 2000],
  ])
    it(`propagates the newest of local and two drives (${first} vs ${second})`, async () => {
      const other = new FakeDrive(),
        targets = [
          { account, remote },
          { account: { ...account, id: "b" }, remote: other },
        ];
      await store.write("n.md", "base", undefined, 1000);
      await syncAll(store, targets);
      await remote.edit("n.md", "from first", first);
      await other.edit("n.md", "from second", second);
      const results = await syncAll(store, targets);
      expect([...results.values()].flatMap((r) => r.errors)).toEqual([]);
      const [winner, loser] =
        first > second
          ? ["from first", "from second"]
          : ["from second", "from first"];
      for (const drive of [remote, other]) {
        expect(drive.data.get("n.md")?.text).toBe(winner);
        expect(drive.data.get("n (conflicted copy).md")?.text).toBe(loser);
      }
      expect((await store.note("n.md"))?.text).toBe(winner);
      expect((await store.note("n.md"))?.modifiedAt).toBe(
        Math.max(first, second),
      );
      expect((await store.note("n (conflicted copy).md"))?.text).toBe(loser);
    });
});
