// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeText } from "@marknotes/sync";
import { Store, type Account } from "../js/storage";
import { SyncEngine } from "../js/sync";
import {
  addConflicts,
  applyMerge,
  describeConflict,
  discardCopy,
  keepBoth,
  loadMerge,
  mergeBack,
  mergeView,
  pendingConflicts,
  type SyncConflict,
} from "../js/conflicts";
import { FakeDrive } from "./fake-drive";

const account: Account = {
  id: "a",
  provider: "dropbox",
  subject: "a",
  label: "work",
  folder: "MarkNotes",
};
const conflict: SyncConflict = {
  path: "n.md",
  copyPath: "n (conflicted copy).md",
  winner: "remote",
  baseText: "one\ntwo\nthree\n",
  driveId: "a",
};
let store: Store;
beforeEach(async () => {
  store = await Store.open(crypto.randomUUID());
});
afterEach(() => {
  store.close();
  document.body.replaceChildren();
});

describe("merge-back logic", () => {
  it("merges the copy into the note, keeping the note's id", () => {
    const result = mergeBack(
      "---\nid: k7f3q2xa\n---\none\ntwo\nthree\n",
      "---\nid: k7f3q2xa\n---\nONE\ntwo\nthree\n",
      "---\nid: m4n5p6q7\n---\none\ntwo\nTHREE\n",
    );
    expect(result.hasConflicts).toBe(false);
    expect(result.text).toBe("---\nid: k7f3q2xa\n---\nONE\ntwo\nTHREE\n");
  });
  it("reports conflicting hunks between the kept version and the copy", () => {
    const result = mergeBack("a\nb\n", "a\nkept\n", "a\ncopy\n");
    expect(result.conflicts).toBe(1);
    expect(result.chunks).toContainEqual({
      kind: "conflict",
      base: ["b\n"],
      local: ["kept\n"],
      remote: ["copy\n"],
    });
  });
  it("lists a conflict once, while both the note and its copy exist", async () => {
    await store.write("n.md", "kept");
    await store.write("n (conflicted copy).md", "copy");
    await addConflicts(store, [conflict, { ...conflict, driveId: "b" }]);
    expect(await pendingConflicts(store)).toEqual([conflict]);
    await store.delete("n.md");
    expect(await pendingConflicts(store)).toEqual([]);
    await store.write("n.md", "back");
    expect(await pendingConflicts(store)).toEqual([]);
  });
  it("saves the merged text as the note and deletes the copy", async () => {
    await store.write("n.md", "one\ntwo\nTHREE\n");
    await store.write("n (conflicted copy).md", "ONE\ntwo\nthree\n");
    await addConflicts(store, [conflict]);
    const merge = (await loadMerge(store, conflict))!;
    expect(merge.text).toBe("ONE\ntwo\nTHREE\n");
    await applyMerge(store, conflict, merge.text);
    expect((await store.note("n.md"))?.text).toBe("ONE\ntwo\nTHREE\n");
    expect(await store.note("n (conflicted copy).md")).toBeUndefined();
    expect(await pendingConflicts(store)).toEqual([]);
  });
  it("discards the copy or keeps both files", async () => {
    await store.write("n.md", "kept");
    await store.write("n (conflicted copy).md", "copy");
    await addConflicts(store, [conflict]);
    await keepBoth(store, conflict);
    expect(await pendingConflicts(store)).toEqual([]);
    expect((await store.note("n (conflicted copy).md"))?.text).toBe("copy");
    await addConflicts(store, [conflict]);
    await discardCopy(store, conflict);
    expect(await store.note("n (conflicted copy).md")).toBeUndefined();
    expect((await store.note("n.md"))?.text).toBe("kept");
    expect(await pendingConflicts(store)).toEqual([]);
  });
  it("explains which version was kept", () => {
    expect(describeConflict(conflict, "Dropbox (work)")).toBe(
      "Changed on this device and on Dropbox (work). The newest version (from Dropbox (work)) was kept; the version from this device was saved as n (conflicted copy).md.",
    );
    expect(
      describeConflict({ ...conflict, winner: "local" }, "Dropbox (work)"),
    ).toContain(
      "The newest version (from this device) was kept; the version from Dropbox (work) was saved",
    );
  });
});

describe("merge-back view", () => {
  const render = (base: string, kept: string, copy: string) => {
    const actions = {
      merge: vi.fn(() => Promise.resolve()),
      discard: vi.fn(() => Promise.resolve()),
      keepBoth: vi.fn(() => Promise.resolve()),
    };
    const view = mergeView(
      conflict,
      "Dropbox (work)",
      mergeBack(base, kept, copy),
      actions,
    );
    document.body.append(view);
    const byText = (text: string) =>
      [...view.querySelectorAll("button")].find((b) => b.textContent === text)!;
    return { view, actions, byText };
  };
  it("shows each conflicting change and enables merging once every change has a choice", async () => {
    const { view, actions, byText } = render(
      "a\nb\nc\nd\n",
      "a\nB1\nc\nD1\n",
      "a\nB2\nc\nD2\n",
    );
    expect(view.textContent).toContain(
      "The newest version (from Dropbox (work)) was kept",
    );
    const hunks = view.querySelectorAll(".merge-conflict");
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.textContent).toContain("Change 1");
    expect(hunks[0]!.textContent).toContain("Kept version");
    expect(hunks[0]!.textContent).toContain("Conflicted copy");
    const options = [...hunks[0]!.querySelectorAll("[role=radio]")].map(
      (r) => r.textContent,
    );
    expect(options).toEqual(["Kept", "Copy", "Both", "Neither"]);
    const merge = byText("Merge copy back");
    expect(merge.disabled).toBe(true);
    const pick = (hunk: number, label: string) =>
      [...hunks[hunk]!.querySelectorAll<HTMLElement>("[role=radio]")]
        .find((r) => r.textContent === label)!
        .click();
    pick(0, "Copy");
    expect(merge.disabled).toBe(true);
    pick(1, "Both");
    expect(merge.disabled).toBe(false);
    merge.click();
    await vi.waitFor(() =>
      expect(actions.merge).toHaveBeenCalledWith("a\nB2\nc\nD1\nD2\n"),
    );
  });
  it("applies Kept and Neither", async () => {
    for (const [index, expected] of [
      [3, "a\n"],
      [0, "a\nk\n"],
    ] as const) {
      const { view, actions, byText } = render("a\nb\n", "a\nk\n", "a\nc\n");
      view.querySelectorAll<HTMLElement>("[role=radio]")[index]!.click();
      byText("Merge copy back").click();
      await vi.waitFor(() =>
        expect(actions.merge).toHaveBeenCalledWith(expected),
      );
      view.remove();
    }
  });
  it("lets the user edit the merged text by hand", async () => {
    const { view, actions, byText } = render("a\nb\n", "a\nk\n", "a\nc\n");
    byText("Edit merged").click();
    const area = view.querySelector("textarea")!;
    expect(area.value).toContain("k");
    byText("Cancel").click();
    expect(view.querySelector("textarea")).toBeNull();
    byText("Edit merged").click();
    view.querySelector("textarea")!.value = "hand merged\n";
    byText("Save").click();
    await vi.waitFor(() =>
      expect(actions.merge).toHaveBeenCalledWith("hand merged\n"),
    );
  });
  it("offers merging straight away when nothing conflicts", () => {
    const { view, byText } = render("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    expect(view.textContent).toContain("merge without conflicts");
    expect(byText("Merge copy back").disabled).toBe(false);
  });
  it("discards the copy, keeps both files, and shows failures", async () => {
    const first = render("a\n", "b\n", "c\n");
    first.byText("Discard copy").click();
    await vi.waitFor(() => expect(first.actions.discard).toHaveBeenCalled());
    first.view.remove();
    const { view, actions, byText } = render("a\n", "b\n", "c\n");
    actions.keepBoth.mockRejectedValueOnce(new Error("Storage full"));
    byText("Keep both files").click();
    await vi.waitFor(() =>
      expect(view.querySelector("[role=alert]")?.textContent).toBe(
        "Storage full",
      ),
    );
    expect(byText("Keep both files").disabled).toBe(false);
  });
});

describe("merge back after a sync conflict", () => {
  it("merges the copy into the note and removes the copy from the drive at the next sync", async () => {
    const remote = new FakeDrive(),
      engine = new SyncEngine(store, account, remote);
    await store.write("n.md", "---\nid: k7f3q2xa\n---\na\nb\n", undefined, 1);
    await engine.run();
    await store.write(
      "n.md",
      "---\nid: k7f3q2xa\n---\na\nmine\n",
      undefined,
      2,
    );
    await remote.edit("n.md", "---\nid: k7f3q2xa\n---\na\ntheirs\n", 3);
    const { conflicts } = await engine.run();
    await addConflicts(store, conflicts);
    const [pending] = await pendingConflicts(store);
    expect(pending?.copyPath).toBe("n (conflicted copy).md");
    expect(remote.data.has("n (conflicted copy).md")).toBe(true);
    const merge = (await loadMerge(store, pending!))!;
    expect(merge.conflicts).toBe(1);
    await applyMerge(store, pending!, mergeText(merge.chunks, { 0: "both" }));
    await engine.run();
    expect(remote.data.has("n (conflicted copy).md")).toBe(false);
    expect(remote.data.get("n.md")?.text).toBe(
      "---\nid: k7f3q2xa\n---\na\ntheirs\nmine\n",
    );
    expect(await pendingConflicts(store)).toEqual([]);
  });
});
