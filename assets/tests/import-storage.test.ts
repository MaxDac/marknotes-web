import { describe, expect, it } from "vitest";
import { openDB } from "idb";
import { Store } from "../js/storage";
import { attachmentPath } from "../js/attachments";
import { noteId } from "../js/notemeta";
import { Session } from "../js/security";
import { MemoryBackend } from "../js/backend";

for (const mode of ["plain", "locked", "ephemeral"] as const) {
  describe(`${mode} document imports`, () => {
    it("commits a new identity and deduplicated images together, numbering taken names", async () => {
      const name = crypto.randomUUID();
      let session = await Session.open(name, 1000);
      try {
        if (mode !== "plain") {
          await session.switchTo(
            mode,
            mode === "locked" ? "correct horse battery" : undefined,
          );
          session.close();
          session = await Session.open(name, 1000);
        }
        const store =
          mode === "locked"
            ? await session.unlock("correct horse battery")
            : await session.store();
        const bytes = new Uint8Array([71, 73, 70]);
        const path = await attachmentPath(bytes, "image/gif");
        const images = [{ path, bytes }];
        await store.create("Work", true);
        expect(
          await store.importNote(
            "Work",
            "First",
            `---\nid: abcdefgh\ncustom: yes\n---\n![Image](${path})`,
            images,
          ),
        ).toBe("Work/First.md");
        await store.importNote("Work", "Second", `![Image](${path})`, images);
        const first = (await store.note("Work/First.md"))!;
        expect(noteId(first.text)).not.toBe("abcdefgh");
        expect(noteId(first.text)).not.toBe(
          noteId((await store.note("Work/Second.md"))!.text),
        );
        expect(first.text).toContain("custom: yes");
        expect(await store.attachmentPaths()).toEqual([path]);
        const otherBytes = new Uint8Array([1, 2, 3]);
        const otherPath = await attachmentPath(otherBytes, "image/gif");
        // Taken names (in any case) get a number, like Android; unreferenced images are not saved.
        expect(
          await store.importNote("Work", "FIRST", "replacement", [
            { path: otherPath, bytes: otherBytes },
          ]),
        ).toBe("Work/FIRST 2.md");
        expect(await store.importNote("Work", "First", "again", [])).toBe(
          "Work/First 3.md",
        );
        expect(await store.attachment(otherPath)).toBeUndefined();
        expect((await store.note("Work/First.md"))?.text).toBe(first.text);
        const db = await openDB(name);
        if (mode !== "plain") {
          expect(await db.getAll("notes")).toEqual([]);
          expect(await db.getAll("attachments")).toEqual([]);
        }
        if (mode === "locked")
          expect((await db.getAll("sealed")).length).toBeGreaterThan(0);
        db.close();
        session.close();
        session = await Session.open(name, 1000);
        const reopened =
          mode === "locked"
            ? await session.unlock("correct horse battery")
            : await session.store();
        if (mode === "ephemeral") {
          expect(await reopened.list()).toEqual([]);
          expect(await reopened.attachmentPaths()).toEqual([]);
        } else {
          expect((await reopened.note("Work/First.md"))?.text).toBe(first.text);
          expect((await reopened.attachment(path))?.bytes).toEqual(bytes);
        }
      } finally {
        session.close();
      }
    });
  });
}

describe("atomic import validation", () => {
  it("rolls back the whole working set when encrypted persistence fails", async () => {
    const store = new Store(
      new MemoryBackend(async () => {
        throw new Error("Storage is full");
      }),
    );
    const bytes = new Uint8Array([1, 2, 3]);
    const path = await attachmentPath(bytes, "image/gif");
    await expect(
      store.importNote("", "Failed", `![](${path})`, [{ path, bytes }]),
    ).rejects.toThrow("Storage is full");
    expect(await store.list()).toEqual([]);
    expect(await store.attachmentPaths()).toEqual([]);
  });
  it("rejects reserved paths, missing parents/references and invalid image hashes without residue", async () => {
    const store = await Store.open(crypto.randomUUID());
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const path = await attachmentPath(bytes, "image/gif");
      await expect(
        store.importNote("attachments", "Bad", "x", []),
      ).rejects.toThrow("reserved");
      await expect(
        store.importNote("Missing", "New", "x", [{ path, bytes }]),
      ).rejects.toThrow("folder");
      await expect(
        store.importNote("", "New", `![](${path})`, []),
      ).rejects.toThrow("missing");
      await expect(
        store.importNote("", "New", `![](${path})`, [
          { path, bytes: new Uint8Array([4]) },
        ]),
      ).rejects.toThrow("hash");
      expect(await store.list()).toEqual([]);
      expect(await store.attachmentPaths()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
