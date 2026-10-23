/**
 * Integration of the sync executor with the real shared core (@marknotes/sync, WebAssembly): two browsers share one
 * drive and go through a full cycle of creation, edits, a merge, a conflict with its merge-back, and deletions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeText, parseManifest } from "@marknotes/sync";
import { Store, type Account } from "../js/storage";
import { syncAll } from "../js/sync";
import { attachmentPath } from "../js/attachments";
import { noteBody, noteId } from "../js/notemeta";
import {
  addConflicts,
  applyMerge,
  loadMerge,
  pendingConflicts,
} from "../js/conflicts";
import { FakeDrive } from "./fake-drive";

const account: Account = {
  id: "drive",
  provider: "dropbox",
  subject: "s",
  label: "shared",
  folder: "MarkNotes",
};
let laptop: Store, phone: Store, drive: FakeDrive;
const sync = async (store: Store) => {
  const results = await syncAll(store, [{ account, remote: drive }]);
  const outcome = results.get("drive")!;
  expect(outcome.errors).toEqual([]);
  await addConflicts(store, outcome.conflicts);
  return outcome;
};
const tree = async (store: Store) =>
  Object.fromEntries(
    (await store.list()).map((n) => [n.path, n.folder ? "/" : n.text]),
  );
beforeEach(async () => {
  laptop = await Store.open(crypto.randomUUID());
  phone = await Store.open(crypto.randomUUID());
  drive = new FakeDrive();
});
afterEach(() => {
  laptop.close();
  phone.close();
});

describe("full sync through the shared core", () => {
  it("keeps two browsers identical through edits, a conflict and its merge-back", async () => {
    const image = new TextEncoder().encode("png");
    const imagePath = await attachmentPath(image, "image/png");
    await laptop.write(
      "work/plan.md",
      "---\nid: k7f3q2xa\n---\nintro\nbody\nend\n",
      undefined,
      1000,
    );
    await laptop.write("todo.md", "milk\n", undefined, 1000);
    await laptop.putAttachment(imagePath, image, 1000);
    await sync(laptop);
    await sync(phone);
    expect(await tree(phone)).toEqual(await tree(laptop));
    expect((await phone.attachment(imagePath))?.bytes).toEqual(image);
    const manifest = parseManifest(drive.manifest!)!;
    expect(Object.keys(manifest.files).sort()).toEqual(
      [imagePath, "todo.md", "work/plan.md"].sort(),
    );

    // Edits to different lines merge.
    await laptop.write(
      "work/plan.md",
      "---\nid: k7f3q2xa\n---\nINTRO\nbody\nend\n",
      undefined,
      2000,
    );
    await sync(laptop);
    await phone.write(
      "work/plan.md",
      "---\nid: k7f3q2xa\n---\nintro\nbody\nEND\n",
      undefined,
      2500,
    );
    expect((await sync(phone)).conflicts).toEqual([]);
    expect((await phone.note("work/plan.md"))?.text).toBe(
      "---\nid: k7f3q2xa\n---\nINTRO\nbody\nEND\n",
    );
    await sync(laptop);
    expect(await tree(laptop)).toEqual(await tree(phone));

    // Overlapping edits: the newest wins and the other is saved as a copy with a new id.
    await laptop.write("todo.md", "milk\neggs\n", undefined, 3000);
    await sync(laptop);
    await phone.write("todo.md", "milk\nbread\n", undefined, 4000);
    const { conflicts } = await sync(phone);
    expect(conflicts.map((c) => [c.copyPath, c.winner])).toEqual([
      ["todo (conflicted copy).md", "local"],
    ]);
    expect(drive.data.get("todo.md")?.text).toBe("milk\nbread\n");
    expect(noteBody(drive.data.get("todo (conflicted copy).md")!.text)).toBe(
      "milk\neggs\n",
    );
    await sync(laptop);
    expect(await tree(laptop)).toEqual(await tree(phone));

    // The phone merges the copy back; the copy disappears everywhere.
    const [conflict] = await pendingConflicts(phone);
    const copyId = noteId((await phone.note(conflict!.copyPath))!.text);
    const merge = (await loadMerge(phone, conflict!))!;
    await applyMerge(phone, conflict!, mergeText(merge.chunks, { 0: "both" }));
    await sync(phone);
    await sync(laptop);
    // The note had no id, so it keeps the one the copy was given.
    const merged = (await laptop.note("todo.md"))!.text;
    expect(noteBody(merged)).toBe("milk\nbread\neggs\n");
    expect(noteId(merged)).toBe(copyId);
    expect(await laptop.note("todo (conflicted copy).md")).toBeUndefined();
    expect(drive.data.has("todo (conflicted copy).md")).toBe(false);

    // Deletions propagate.
    await laptop.delete("work");
    await laptop.deleteAttachment(imagePath);
    await sync(laptop);
    await sync(phone);
    expect(Object.keys(await tree(phone))).toEqual(["todo.md"]);
    expect(await phone.attachment(imagePath)).toBeUndefined();
    expect(await tree(laptop)).toEqual(await tree(phone));
  });
});
