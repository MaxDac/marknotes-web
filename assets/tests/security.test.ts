import { afterEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import { MemoryBackend } from "../js/backend";
import {
  decode,
  encode,
  forgetDevice,
  Session,
  validatePassphrase,
} from "../js/security";
import { Store, Vault } from "../js/storage";

const PASS = "correct horse battery";
const ITER = 1000;
const open: Session[] = [];
async function session(name: string): Promise<Session> {
  const s = await Session.open(name, ITER);
  open.push(s);
  return s;
}
function done(s: Session): void {
  s.close();
  open.splice(open.indexOf(s), 1);
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
async function raw(name: string) {
  const db = await openDB(name);
  const dump = {
    notes: await db.getAll("notes"),
    values: await db.getAllKeys("values"),
    attachments: await db.getAll("attachments"),
    sealed: await db.getAll("sealed"),
    sealedIds: await db.getAllKeys("sealed"),
  };
  db.close();
  return dump;
}
const text = (bytes: ArrayBuffer) =>
  new TextDecoder("latin1").decode(new Uint8Array(bytes));

describe("memory backend", () => {
  it("behaves like IndexedDB for the note tree and rolls back failed transactions", async () => {
    const store = new Store(new MemoryBackend());
    const first = await store.write("a/n.md", "one");
    expect((await store.note("a"))?.folder).toBe(true);
    await expect(store.write("a/n.md", "x", "stale")).rejects.toThrow(
      "another tab",
    );
    await expect(store.create("a/n.md", false)).rejects.toThrow(
      "already exists",
    );
    await store.write("b.md", "two");
    await expect(store.move("a", "b.md")).rejects.toThrow("already exists");
    expect((await store.note("a/n.md"))?.revision).toBe(first.revision);
    await store.move("a", "c");
    expect((await store.list()).map((n) => n.path)).toEqual([
      "b.md",
      "c",
      "c/n.md",
    ]);
    const note = await store.note("b.md");
    note!.text = "mutated";
    expect((await store.note("b.md"))?.text).toBe("two");
    await store.put("x:base:c", "1");
    await store.put("x:base:c/n.md", "2");
    await store.put("x:base:cc", "3");
    await store.deleteBase("x", "c");
    expect(await store.value("x:base:cc")).toBe("3");
    expect(await store.value("x:base:c/n.md")).toBeUndefined();
  });
  it("does not apply changes the persistence layer rejected", async () => {
    let fail = false;
    const store = new Store(
      new MemoryBackend(async () => {
        if (fail) throw new Error("disk full");
      }),
    );
    await store.write("n.md", "kept");
    fail = true;
    await expect(store.write("n.md", "lost")).rejects.toThrow("disk full");
    expect((await store.note("n.md"))?.text).toBe("kept");
  });
});

describe("sealed encoding", () => {
  it("round-trips binary values and refuses crypto keys", async () => {
    const value = {
      bytes: new Uint8Array([0, 255, 7]),
      buffer: new Uint8Array([1, 2]).buffer,
      text: "café",
    };
    const back = decode(encode(value).buffer) as typeof value;
    expect([...back.bytes]).toEqual([0, 255, 7]);
    expect([...new Uint8Array(back.buffer)]).toEqual([1, 2]);
    expect(back.text).toBe("café");
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    expect(() => encode({ key })).toThrow("cannot be sealed");
  });
  it("requires a reasonable passphrase", () => {
    expect(() => validatePassphrase("short")).toThrow("at least 10");
    expect(() => validatePassphrase(PASS)).not.toThrow();
  });
});

describe("storage modes", () => {
  it("encrypts everything at rest with a passphrase and unlocks it again", async () => {
    const name = crypto.randomUUID();
    let s = await session(name);
    expect(s.mode).toBe("plain");
    let store = await s.store();
    await store.write("Secret folder/Diary.md", "SENTINEL_TEXT");
    await store.putAttachment("attachments/abc.png", new Uint8Array([9, 8, 7]));
    await store.saveAccount({
      id: "d1",
      provider: "dropbox",
      label: "me@example.com",
      folder: "MarkNotes",
      subject: "sub",
    });
    await new Vault(store).save("d1", { access: "TOKEN_SENTINEL" });
    await store.putBase("d1", "Secret folder/Diary.md", "BASE_SENTINEL");
    await s.switchTo("locked", PASS);
    done(s);

    const disk = await raw(name);
    expect(disk.notes).toEqual([]);
    expect(disk.values).toEqual([]);
    expect(disk.attachments).toEqual([]);
    expect(disk.sealed.length).toBeGreaterThan(4);
    const blob =
      disk.sealed.map((r) => text(r.bytes)).join("") + disk.sealedIds.join("");
    for (const secret of [
      "SENTINEL_TEXT",
      "Diary",
      "Secret folder",
      "TOKEN_SENTINEL",
      "BASE_SENTINEL",
      "me@example.com",
    ])
      expect(blob).not.toContain(secret);

    s = await session(name);
    expect(s.mode).toBe("locked");
    expect(s.locked).toBe(true);
    await expect(s.store()).rejects.toThrow("Unlock");
    await expect(s.unlock("wrong passphrase!")).rejects.toThrow(
      "Wrong passphrase",
    );
    store = await s.unlock(PASS);
    expect((await store.note("Secret folder/Diary.md"))?.text).toBe(
      "SENTINEL_TEXT",
    );
    expect([...(await store.attachment("attachments/abc.png"))!.bytes]).toEqual(
      [9, 8, 7],
    );
    expect(await new Vault(store).load("d1")).toEqual({
      access: "TOKEN_SENTINEL",
    });
    expect(await store.base("d1", "Secret folder/Diary.md")).toBe(
      "BASE_SENTINEL",
    );
    await store.write("Later.md", "LATER_SENTINEL");
    await store.delete("Secret folder");
    await s.changePassphrase(PASS, "another long passphrase");
    done(s);

    s = await session(name);
    await expect(s.unlock(PASS)).rejects.toThrow("Wrong passphrase");
    store = await s.unlock("another long passphrase");
    expect((await store.list()).map((n) => n.path)).toEqual(["Later.md"]);
    expect(
      (await raw(name)).sealed.map((r) => text(r.bytes)).join(""),
    ).not.toContain("LATER_SENTINEL");

    await s.switchTo("plain");
    done(s);
    s = await session(name);
    expect(s.mode).toBe("plain");
    store = await s.store();
    expect((await store.note("Later.md"))?.text).toBe("LATER_SENTINEL");
    expect(await new Vault(store).load("d1")).toEqual({
      access: "TOKEN_SENTINEL",
    });
    expect((await raw(name)).sealed).toEqual([]);
  });
  it("detects swapped or altered sealed records", async () => {
    const name = crypto.randomUUID();
    const s = await session(name);
    const store = await s.store();
    await store.write("a.md", "A");
    await store.write("b.md", "B");
    await s.switchTo("locked", PASS);
    done(s);
    const db = await openDB(name);
    const ids = await db.getAllKeys("sealed");
    const first = await db.get("sealed", ids[0]!);
    await db.put("sealed", await db.get("sealed", ids[1]!), ids[0]!);
    await db.put("sealed", first, ids[1]!);
    db.close();
    const again = await session(name);
    await expect(again.unlock(PASS)).rejects.toThrow("tampered");
  });
  it("keeps memory-only storage off disk and enforces a single tab", async () => {
    const name = crypto.randomUUID();
    let s = await session(name);
    await (await s.store()).write("old.md", "OLD");
    await s.switchTo("ephemeral");
    done(s);
    expect((await raw(name)).notes).toEqual([]);

    s = await session(name);
    expect(s.mode).toBe("ephemeral");
    const store = await s.store();
    expect(await store.list()).toEqual([]);
    await store.write("tmp.md", "TEMP");
    await new Vault(store).save("x", { access: "t" });
    expect(await new Vault(store).load("x")).toEqual({ access: "t" });
    const disk = await raw(name);
    expect(disk.notes).toEqual([]);
    expect(disk.values).toEqual([]);
    await expect(Session.open(name, ITER)).rejects.toThrow("another tab");

    await s.switchTo("plain");
    done(s);
    const plain = await session(name);
    const kept = await plain.store();
    expect((await kept.note("tmp.md"))?.text).toBe("TEMP");
    expect(await new Vault(kept).load("x")).toEqual({ access: "t" });
  });
  it("refuses to change storage while another tab is open", async () => {
    const name = crypto.randomUUID();
    const a = await session(name);
    await session(name);
    await expect(a.switchTo("ephemeral")).rejects.toThrow(
      "other MarkNotes tabs",
    );
  });
  it("forgets everything stored on this device", async () => {
    const name = crypto.randomUUID();
    const s = await session(name);
    await (await s.store()).write("n.md", "text");
    await s.switchTo("locked", PASS);
    open.splice(open.indexOf(s), 1);
    await s.forget();
    const fresh = await session(name);
    expect(fresh.mode).toBe("plain");
    expect(await (await fresh.store()).list()).toEqual([]);
    await forgetDevice(crypto.randomUUID());
  });
});
