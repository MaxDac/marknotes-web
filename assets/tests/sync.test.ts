import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "@marknotes/sync";
import { Store, type Account } from "../js/storage";
import { SyncEngine, localTime, syncAll } from "../js/sync";
import { isChordSequence, parseChordBody } from "../js/chords";
import { noteBody, noteId } from "../js/notemeta";
import { FakeDrive } from "./fake-drive";
let store: Store, remote: FakeDrive, engine: SyncEngine;
const account: Account = {
  id: "a",
  provider: "dropbox",
  subject: "a",
  label: "test",
  folder: "MarkNotes",
};
const second: Account = { ...account, id: "b", provider: "onedrive" };
beforeEach(async () => {
  store = await Store.open(crypto.randomUUID());
  remote = new FakeDrive();
  engine = new SyncEngine(store, account, remote);
});
afterEach(() => store.close());
describe("sync engine", () => {
  it("uploads local notes and folders and publishes the manifest", async () => {
    await store.write("folder/n.md", "hello\n");
    expect((await engine.run()).errors).toEqual([]);
    expect(remote.data.get("folder")?.entry.folder).toBe(true);
    expect(remote.data.get("folder/n.md")?.text).toBe("hello\n");
    const m = parseManifest(remote.manifest!)!;
    expect(m.deviceId).toBe(await store.deviceId());
    expect(m.files["folder/n.md"]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.files["folder/n.md"]?.version).toBe(
      remote.data.get("folder/n.md")?.entry.version,
    );
    remote.uploads = [];
    await engine.run();
    expect(remote.uploads).toEqual([]);
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
    expect((await engine.run()).changes).toBe(1);
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
  it("three-way merges edits that do not overlap", async () => {
    await store.write("n.md", "one\ntwo\nthree\n", undefined, 1000);
    await engine.run();
    await store.write("n.md", "ONE\ntwo\nthree\n", undefined, 2000);
    await remote.edit("n.md", "one\ntwo\nTHREE\n", 3000);
    const result = await engine.run();
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect((await store.note("n.md"))?.text).toBe("ONE\ntwo\nTHREE\n");
    expect(remote.data.get("n.md")?.text).toBe("ONE\ntwo\nTHREE\n");
    expect(await store.note("n (conflicted copy).md")).toBeUndefined();
    remote.uploads = [];
    await engine.run();
    expect(remote.uploads).toEqual([]);
  });
  it("keeps the newer drive edit and saves the older local one as a copy", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await store.write("n.md", "mine", undefined, 2000);
    await remote.edit("n.md", "theirs", 3000);
    const result = await engine.run();
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        path: "n.md",
        copyPath: "n (conflicted copy).md",
        winner: "remote",
        baseText: "one",
        driveId: "a",
      },
    ]);
    const local = await store.note("n.md");
    expect(local?.text).toBe("theirs");
    expect(local?.modifiedAt).toBe(3000);
    expect(remote.data.get("n.md")?.text).toBe("theirs");
    expect(noteBody((await store.note("n (conflicted copy).md"))!.text)).toBe(
      "mine",
    );
    expect(noteBody(remote.data.get("n (conflicted copy).md")!.text)).toBe(
      "mine",
    );
    expect(remote.data.get("n (conflicted copy).md")?.entry.modifiedAt).toBe(
      2000,
    );
    remote.uploads = [];
    expect((await engine.run()).conflicts).toEqual([]);
    expect(remote.uploads).toEqual([]);
  });
  it("keeps the newer local edit and overwrites the drive", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await remote.edit("n.md", "theirs", 2000);
    await store.write("n.md", "mine", undefined, 3000);
    const result = await engine.run();
    expect(result.conflicts.map((c) => [c.copyPath, c.winner])).toEqual([
      ["n (conflicted copy).md", "local"],
    ]);
    expect(remote.data.get("n.md")?.text).toBe("mine");
    expect(remote.data.get("n.md")?.entry.modifiedAt).toBe(3000);
    expect((await store.note("n.md"))?.text).toBe("mine");
    expect(noteBody((await store.note("n (conflicted copy).md"))!.text)).toBe(
      "theirs",
    );
    expect(noteBody(remote.data.get("n (conflicted copy).md")!.text)).toBe(
      "theirs",
    );
  });
  it("reconciles differing initial versions by modification time, without a base", async () => {
    await store.write("n.md", "mine", undefined, 1000);
    await remote.edit("n.md", "theirs", 2000);
    const { conflicts } = await engine.run();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.baseText).toBeNull();
    expect((await store.note("n.md"))?.text).toBe("theirs");
    expect(noteBody((await store.note("n (conflicted copy).md"))!.text)).toBe(
      "mine",
    );
  });
  it("gives a tie to the drive", async () => {
    await store.write("n.md", "mine", undefined, 2000);
    await remote.edit("n.md", "theirs", 2000);
    await engine.run();
    expect(remote.data.get("n.md")?.text).toBe("theirs");
    expect((await store.note("n.md"))?.text).toBe("theirs");
    expect(noteBody((await store.note("n (conflicted copy).md"))!.text)).toBe(
      "mine",
    );
  });
  it("gives conflicted copies a new id so links keep targeting the original", async () => {
    await store.write("n.md", "---\nid: k7f3q2xa\n---\nmine", undefined, 1000);
    await remote.edit("n.md", "---\nid: k7f3q2xa\n---\ntheirs", 2000);
    await engine.run();
    const copy = (await store.note("n (conflicted copy).md"))!.text;
    expect(copy).toMatch(/^---\nid: [0-9a-z]{8}\n---\nmine$/);
    expect(noteId(copy)).not.toBe("k7f3q2xa");
    expect(remote.data.get("n (conflicted copy).md")?.text).toBe(copy);
    expect((await store.note("n.md"))?.text).toContain("k7f3q2xa");
  });
  it("gives a new id to a copy of a note without one", async () => {
    await store.write("n.md", "mine", undefined, 1000);
    await remote.edit("n.md", "theirs", 2000);
    await engine.run();
    const copy = (await store.note("n (conflicted copy).md"))!.text;
    expect(copy).toMatch(/^---\nid: [0-9a-z]{8}\n---\nmine$/);
    expect(remote.data.get("n (conflicted copy).md")?.text).toBe(copy);
    expect((await store.note("n.md"))?.text).toBe("theirs");
  });
  it("syncs chord sequences as ordinary notes and keeps their type on conflicted copies", async () => {
    const head = "---\nid: c4d12345\ntype: chords\n---\n";
    const mine = `${head}## C (guitar)\nfrets: x 3/3 2/2 0 1/1 0\n`;
    const theirs = `${head}## G (guitar)\nfrets: 3/2 2/1 0 0 0 3/3\n`;
    await store.write("song.md", mine, undefined, 1000);
    await engine.run();
    expect(remote.data.get("song.md")?.text).toBe(mine);
    await store.write(
      "song.md",
      `${head}## D (guitar)\nfrets: x x 0 2/1 3/3 2/2\n`,
      undefined,
      2000,
    );
    await remote.edit("song.md", theirs, 3000);
    expect((await engine.run()).conflicts.map((c) => c.copyPath)).toEqual([
      "song (conflicted copy).md",
    ]);
    expect((await store.note("song.md"))?.text).toBe(theirs);
    const copy = (await store.note("song (conflicted copy).md"))!.text;
    expect(isChordSequence(copy)).toBe(true);
    expect(copy).not.toContain("c4d12345");
    expect(parseChordBody(noteBody(copy)).sequence?.chords[0]?.baseName).toBe(
      "D",
    );
  });
  it("numbers the copy when the conflicted copy name is taken, keeping the extension's case", async () => {
    await store.write("n.MD", "mine", undefined, 1000);
    await store.write("n (conflicted copy).MD", "existing", undefined, 1000);
    await remote.edit("n.MD", "theirs", 2000);
    await engine.run();
    expect(noteBody((await store.note("n (conflicted copy) 2.MD"))!.text)).toBe(
      "mine",
    );
    expect((await store.note("n (conflicted copy).MD"))?.text).toBe("existing");
    expect((await store.note("n.MD"))?.text).toBe("theirs");
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
  it("reports a failing step and goes on with the others", async () => {
    await store.write("a.md", "a");
    await store.write("b.md", "b");
    remote.failing.add("a.md");
    const result = await engine.run();
    expect(result.errors).toEqual(["a.md: Upload failed"]);
    expect(remote.data.get("b.md")?.text).toBe("b");
    expect(parseManifest(remote.manifest!)?.files["b.md"]).toBeDefined();
    remote.failing.clear();
    expect((await engine.run()).errors).toEqual([]);
    expect(remote.data.get("a.md")?.text).toBe("a");
  });
  it("syncs from content when the manifest is unreadable", async () => {
    remote.manifest = "{bad";
    await remote.edit("n.md", "remote");
    expect((await engine.run()).errors).toEqual([]);
    expect((await store.note("n.md"))?.text).toBe("remote");
    expect(parseManifest(remote.manifest)?.files["n.md"]).toBeDefined();
  });
  it("syncs even when the manifest cannot be read", async () => {
    remote.readManifest = () => Promise.reject(new Error("offline"));
    await remote.edit("n.md", "remote");
    expect((await engine.run()).errors).toEqual([]);
    expect((await store.note("n.md"))?.text).toBe("remote");
  });
  it("keeps base copies per drive and forgets them with the note", async () => {
    await store.write("f/n.md", "one");
    await engine.run();
    expect(await store.base("a", "f/n.md")).toBe("one");
    await store.delete("f");
    await engine.run();
    expect(await store.base("a", "f/n.md")).toBeUndefined();
  });
  it("does not overwrite a note saved while its download was in flight", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await remote.edit("n.md", "two", 2000);
    remote.onDownload = async () => {
      remote.onDownload = undefined;
      await store.write("n.md", "local edit", undefined, 3000);
    };
    const result = await engine.run();
    expect(result.errors).toEqual([]);
    expect(result.changes).toBe(0);
    expect((await store.note("n.md"))?.text).toBe("local edit");
    // The next sync sees both edits and keeps both versions.
    const next = await engine.run();
    expect(next.conflicts.map((c) => c.copyPath)).toEqual([
      "n (conflicted copy).md",
    ]);
    expect(remote.data.get("n.md")?.text).toBe("local edit");
    expect(noteBody(remote.data.get("n (conflicted copy).md")!.text)).toBe(
      "two",
    );
  });
  it("does not delete a note saved after the plan was made", async () => {
    await store.write("n.md", "one");
    await engine.run();
    remote.data.delete("n.md");
    remote.onSnapshot = async () => {
      remote.onSnapshot = undefined;
      await store.write("n.md", "edited");
    };
    expect((await engine.run()).errors).toEqual([]);
    expect((await store.note("n.md"))?.text).toBe("edited");
    await engine.run();
    expect(remote.data.get("n.md")?.text).toBe("edited");
  });
  it("does not delete a folder that gained a note after the plan was made", async () => {
    await store.write("f/a.md", "one");
    await engine.run();
    await remote.delete(remote.data.get("f")!.entry);
    remote.onSnapshot = async () => {
      remote.onSnapshot = undefined;
      await store.write("f/new.md", "new");
    };
    await engine.run();
    expect((await store.note("f/new.md"))?.text).toBe("new");
    await engine.run();
    expect(remote.data.get("f/new.md")?.text).toBe("new");
  });
  it("does not merge into a note saved while the drive copy was downloading", async () => {
    await store.write("n.md", "one\ntwo\n", undefined, 1000);
    await engine.run();
    await store.write("n.md", "ONE\ntwo\n", undefined, 2000);
    await remote.edit("n.md", "one\nTWO\n", 3000);
    remote.onDownload = async () => {
      remote.onDownload = undefined;
      await store.write("n.md", "typed meanwhile\n", undefined, 4000);
    };
    await engine.run();
    expect((await store.note("n.md"))?.text).toBe("typed meanwhile\n");
    expect(remote.data.get("n.md")?.text).toBe("one\nTWO\n");
  });
  it("keeps the record when the drive copy changed before a remote delete", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await store.delete("n.md");
    remote.readManifest = async () => {
      await remote.edit("n.md", "edited elsewhere", 2000);
      remote.readManifest = async () => remote.manifest;
      return remote.manifest;
    };
    const result = await engine.run();
    expect(result.errors).toEqual(["n.md: Revision conflict"]);
    expect(remote.data.get("n.md")?.text).toBe("edited elsewhere");
    await engine.run();
    expect((await store.note("n.md"))?.text).toBe("edited elsewhere");
  });
  it("saves the conflicted copy before overwriting the note", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await store.write("n.md", "mine", undefined, 2000);
    await remote.edit("n.md", "theirs", 3000);
    const write = store.write.bind(store);
    store.write = (path, ...rest) =>
      path === "n (conflicted copy).md"
        ? Promise.reject(new Error("disk full"))
        : write(path, ...rest);
    expect((await engine.run()).errors).toEqual(["n.md: disk full"]);
    expect((await store.note("n.md"))?.text).toBe("mine");
    store.write = write;
    const result = await engine.run();
    expect(result.errors).toEqual([]);
    expect((await store.note("n.md"))?.text).toBe("theirs");
    expect(noteBody((await store.note("n (conflicted copy).md"))!.text)).toBe(
      "mine",
    );
  });
  it("uploads a conflicted copy on the next sync when its upload fails", async () => {
    await store.write("n.md", "one", undefined, 1000);
    await engine.run();
    await store.write("n.md", "mine", undefined, 2000);
    await remote.edit("n.md", "theirs", 3000);
    remote.failing.add("n (conflicted copy).md");
    const result = await engine.run();
    expect(result.errors).toEqual(["n.md: Upload failed"]);
    expect(result.conflicts).toHaveLength(1);
    expect((await store.note("n.md"))?.text).toBe("theirs");
    expect(noteBody((await store.note("n (conflicted copy).md"))!.text)).toBe(
      "mine",
    );
    remote.failing.clear();
    expect((await engine.run()).errors).toEqual([]);
    expect(noteBody(remote.data.get("n (conflicted copy).md")!.text)).toBe(
      "mine",
    );
  });
  it("keeps a byte order mark and does not rewrite downloaded bytes", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    await remote.upload("n.md", bytes);
    await engine.run();
    expect((await store.note("n.md"))?.text).toBe("\ufeffhi");
    remote.uploads = [];
    await engine.run();
    expect(remote.uploads).toEqual([]);
    await store.write("n.md", "\ufeffhi!");
    await engine.run();
    expect(remote.data.get("n.md")?.text).toBe("\ufeffhi!");
  });
  it("does not rewrite a note that is not valid UTF-8 until it is edited", async () => {
    const bytes = new Uint8Array([0x68, 0xff]);
    await remote.upload("n.md", bytes);
    await engine.run();
    expect((await store.note("n.md"))?.text).toBe("h\ufffd");
    remote.uploads = [];
    await engine.run();
    expect(remote.uploads).toEqual([]);
    expect(remote.data.get("n.md")?.bytes).toEqual(bytes);
  });
});
describe("syncAll", () => {
  it("requeues other drives after downloads", async () => {
    const other = new FakeDrive();
    await other.edit("new.md", "second");
    const result = await syncAll(store, [
      { account, remote },
      { account: second, remote: other },
    ]);
    expect([...result.values()].flatMap((r) => r.errors)).toEqual([]);
    expect(remote.data.get("new.md")?.text).toBe("second");
  });
  it("reports a drive that fails and still syncs the others", async () => {
    const other = new FakeDrive();
    remote.fail = true;
    await store.write("n.md", "local");
    const result = await syncAll(store, [
      { account, remote },
      { account: second, remote: other },
    ]);
    expect(result.get("a")?.errors).toEqual(["Unavailable"]);
    expect(result.get("b")?.errors).toEqual([]);
    expect(other.data.get("n.md")?.text).toBe("local");
  });
  for (const [first, last] of [
    [2000, 3000],
    [3000, 2000],
  ])
    it(`propagates the newest of two drives and the copy to every drive (${first} vs ${last})`, async () => {
      const other = new FakeDrive(),
        targets = [
          { account, remote },
          { account: second, remote: other },
        ];
      await store.write("n.md", "base", undefined, 1000);
      await syncAll(store, targets);
      await remote.edit("n.md", "from first", first);
      await other.edit("n.md", "from second", last);
      const results = await syncAll(store, targets);
      expect([...results.values()].flatMap((r) => r.errors)).toEqual([]);
      const [winner, loser] =
        first > last
          ? ["from first", "from second"]
          : ["from second", "from first"];
      for (const drive of [remote, other]) {
        expect(drive.data.get("n.md")?.text).toBe(winner);
        expect(noteBody(drive.data.get("n (conflicted copy).md")!.text)).toBe(
          loser,
        );
      }
      expect((await store.note("n.md"))?.text).toBe(winner);
      expect((await store.note("n.md"))?.modifiedAt).toBe(
        Math.max(first, last),
      );
      expect(noteBody((await store.note("n (conflicted copy).md"))!.text)).toBe(
        loser,
      );
      const conflicts = [...results.values()].flatMap((r) => r.conflicts);
      expect(conflicts.map((c) => c.copyPath)).toEqual([
        "n (conflicted copy).md",
      ]);
    });
});
