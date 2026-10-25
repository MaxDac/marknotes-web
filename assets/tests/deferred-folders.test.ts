import { afterEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import { Session } from "../js/security";
import { Store, type Account, type RecordState } from "../js/storage";
import { SyncEngine } from "../js/sync";
import { Dropbox, OneDrive } from "../js/providers";
import { FakeDrive } from "./fake-drive";

const account: Account = {
  id: "d1",
  provider: "dropbox",
  subject: "d1",
  label: "test",
  folder: "MarkNotes",
};
const PASS = "correct horse battery";
const closing: { close(): void }[] = [];
afterEach(() => {
  for (const c of closing.splice(0)) c.close();
});
function unsupportedDrive(): FakeDrive {
  const remote = new FakeDrive();
  remote.remoteFolderDeletion = "unsupported";
  remote.supportsEmptyDelete = false;
  return remote;
}
/** Syncs a folder `Old notes`, deletes it here and syncs again, which keeps it on the drive. */
async function preserve(store: Store, remote: FakeDrive): Promise<void> {
  await store.create("Old notes", true);
  expect((await new SyncEngine(store, account, remote).run()).errors).toEqual(
    [],
  );
  await store.delete("Old notes");
  expect((await new SyncEngine(store, account, remote).run()).errors).toEqual(
    [],
  );
}

describe("deferred remote folder removal", () => {
  it("is declared by the providers that cannot delete only empty folders", () => {
    expect(new Dropbox(undefined!, account).remoteFolderDeletion).toBe(
      "unsupported",
    );
    expect(
      new OneDrive(undefined!, { ...account, provider: "onedrive" })
        .remoteFolderDeletion,
    ).toBe("unsupported");
  });
  it("keeps the folder on the drive with one pending notice that survives reopening once acknowledged", async () => {
    const name = crypto.randomUUID();
    let store = await Store.open(name);
    closing.push(store);
    const remote = unsupportedDrive();
    await preserve(store, remote);
    expect(remote.data.get("Old notes")?.entry.folder).toBe(true);
    const record = (
      (await store.value<RecordState[]>(`${account.id}:records`)) ?? []
    ).find((r) => r.path === "Old notes");
    expect(record?.remoteFolderPreserved).toBe(true);
    const issued = await store.folderNotices(account.id);
    expect(issued).toHaveLength(1);
    let notice = issued[0];
    expect(notice).toMatchObject({
      path: "Old notes",
      remoteId: remote.data.get("Old notes")!.entry.id,
      acknowledged: false,
      active: true,
    });

    expect((await new SyncEngine(store, account, remote).run()).errors).toEqual(
      [],
    );
    expect(await store.folderNotices(account.id)).toEqual([notice]);
    expect(await store.note("Old notes")).toBeUndefined();

    await store.acknowledgeFolderNotice(account.id, notice!.generation);
    store.close();
    store = await Store.open(name);
    closing.push(store);
    [notice] = await store.folderNotices(account.id);
    expect(notice).toMatchObject({ acknowledged: true, active: true });
    await new SyncEngine(store, account, remote).run();
    expect(await store.folderNotices(account.id)).toEqual([notice]);
    await expect(
      store.acknowledgeFolderNotice(account.id, "unknown"),
    ).rejects.toThrow("no longer exists");
  });
  it("retires the notice when the folder is recreated here and issues a new one for a later deletion", async () => {
    const store = await Store.open(crypto.randomUUID());
    closing.push(store);
    const remote = unsupportedDrive();
    await preserve(store, remote);
    await store.create("Old notes", true);
    expect((await new SyncEngine(store, account, remote).run()).errors).toEqual(
      [],
    );
    expect(remote.data.get("Old notes")?.entry.folder).toBe(true);
    expect(
      (await store.folderNotices(account.id)).map((n) => n.active),
    ).toEqual([false]);

    await store.delete("Old notes");
    await new SyncEngine(store, account, remote).run();
    const notices = await store.folderNotices(account.id);
    expect(notices.map((n) => n.active)).toEqual([false, true]);
    expect(new Set(notices.map((n) => n.generation)).size).toBe(2);
  });
  it("forgets a drive's notices with the drive", async () => {
    const store = await Store.open(crypto.randomUUID());
    closing.push(store);
    await store.saveAccount(account);
    await preserve(store, unsupportedDrive());
    await store.forgetAccount(account.id);
    expect(await store.folderNotices(account.id)).toEqual([]);
  });
  it("stores notices with the storage mode: sealed with a passphrase and off disk in memory only", async () => {
    for (const mode of ["locked", "ephemeral"] as const) {
      const name = crypto.randomUUID();
      let s = await Session.open(name, 1000);
      closing.push(s);
      await s.switchTo(mode, mode === "locked" ? PASS : undefined);
      s.close();
      s = await Session.open(name, 1000);
      closing.push(s);
      const store = mode === "locked" ? await s.unlock(PASS) : await s.store();
      await preserve(store, unsupportedDrive());
      expect(await store.folderNotices(account.id)).toHaveLength(1);

      const db = await openDB(name);
      const keys = (await db.getAllKeys("values")).map(String);
      const sealed = (await db.getAll("sealed")) as { bytes: ArrayBuffer }[];
      db.close();
      expect(keys.filter((k) => k.startsWith(account.id))).toEqual([]);
      const blob = sealed
        .map((r) => new TextDecoder("latin1").decode(new Uint8Array(r.bytes)))
        .join("");
      expect(blob).not.toContain("Old notes");
      expect(blob).not.toContain("folder-notices");
      if (mode === "ephemeral") expect(sealed).toEqual([]);
      s.close();
      if (mode === "locked") {
        s = await Session.open(name, 1000);
        closing.push(s);
        const again = await s.unlock(PASS);
        expect(
          (await again.folderNotices(account.id)).map((n) => n.path),
        ).toEqual(["Old notes"]);
        s.close();
      }
    }
  });
});
