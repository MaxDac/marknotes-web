import { expect, test, type Page } from "./fixtures";

const ID = "---\nid: k7f3q2xa\n---\n";

/**
 * Connects a mocked OneDrive, edits Shared.md here while the drive gets a newer edit of the same line, and syncs: the
 * drive's version is kept and this device's version becomes "Shared (conflicted copy).md".
 */
async function conflict(page: Page) {
  interface Item {
    id: string;
    name: string;
    content: string;
    revision: number;
    modified: string;
  }
  const items = new Map<string, Item>([
    [
      "note",
      {
        id: "note",
        name: "Shared.md",
        content: `${ID}intro\nbase line\noutro\n`,
        revision: 1,
        modified: "2024-01-01T00:00:00Z",
      },
    ],
  ]);
  const note = items.get("note")!;
  const node = (item: Item) => ({
    id: item.id,
    name: item.name,
    file: {},
    cTag: `c${item.id}${item.revision}`,
    eTag: `e${item.id}${item.revision}`,
    fileSystemInfo: { lastModifiedDateTime: item.modified },
    parentReference: { id: "root" },
  });
  const drive = {
    note,
    copy: () => [...items.values()].find((item) => item !== note),
  };
  await page.route("https://graph.microsoft.com/**", async (route) => {
    const request = route.request(),
      method = request.method(),
      path = decodeURIComponent(new URL(request.url()).pathname);
    const reply = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    const guarded = (item: Item) =>
      expect(request.headers()["if-match"]).toBe(node(item).eTag);
    if (path.endsWith("/root"))
      return reply({ id: "root", name: "root", folder: {} });
    if (path.endsWith("/root/delta") || path.endsWith("/checkpoint"))
      return reply({
        value: [...items.values()].map(node),
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/checkpoint",
      });
    if (path.includes("manifest.json")) {
      if (method === "PUT")
        return reply({ id: "manifest", name: "manifest.json", eTag: "m1" });
      return reply({}, 404);
    }
    if (path.endsWith("/children"))
      return reply({
        id: "metadata",
        name: ".marknotes",
        folder: {},
        parentReference: { id: "root" },
      });
    const created = /\/items\/root:\/(.+):\/content$/.exec(path);
    if (created && method === "PUT") {
      const item = {
        id: `copy${items.size}`,
        name: created[1]!,
        content: request.postData() ?? "",
        revision: 1,
        modified: new Date().toISOString(),
      };
      items.set(item.id, item);
      return reply(node(item));
    }
    const [, id, content] = /\/items\/([^/:]+)(\/content)?$/.exec(path) ?? [];
    const item = id ? items.get(id) : undefined;
    if (!item) return reply({}, 404);
    if (content && method === "PUT") {
      guarded(item);
      item.content = request.postData() ?? "";
      item.revision++;
      return reply(node(item));
    }
    if (method === "PATCH") {
      guarded(item);
      const body = request.postDataJSON() as {
        fileSystemInfo?: { lastModifiedDateTime: string };
      };
      if (body.fileSystemInfo)
        item.modified = body.fileSystemInfo.lastModifiedDateTime;
      return reply(node(item));
    }
    if (method === "DELETE") {
      guarded(item);
      items.delete(item.id);
      return route.fulfill({ status: 204 });
    }
    return reply({
      ...node(item),
      "@microsoft.graph.downloadUrl": `https://public.bn.files.1drv.com/${item.id}`,
    });
  });
  await page.route("https://public.bn.files.1drv.com/*", (route) => {
    const item = items.get(new URL(route.request().url()).pathname.slice(1));
    return item
      ? route.fulfill({ body: item.content })
      : route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "New", exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("marknotes");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(
        JSON.stringify({
          access: "graph-browser-only-token",
          expires: Date.now() + 3600000,
        }),
      ),
    );
    const tx = db.transaction("values", "readwrite"),
      values = tx.objectStore("values");
    values.put(key, "vault-key");
    values.put({ iv, bytes }, "graph:credentials");
    values.put(
      [
        {
          id: "graph",
          subject: "home",
          label: "graph@example.invalid",
          provider: "onedrive",
          folder: "",
        },
      ],
      "accounts",
    );
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("Sync finished");
  await page.locator('#tree button[data-path="Shared.md"]').click();
  await expect(page.locator("#workspace")).toBeEnabled();
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await expect(editor).toContainText("base line");
  await editor.fill("intro\nmy line\noutro\n");
  await expect(page.locator("#status")).toContainText("Saved in this browser");
  // Another device edits the same line later.
  note.content = `${ID}intro\ntheir line\noutro\n`;
  note.revision++;
  note.modified = new Date(Date.now() + 60000).toISOString();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("#status")).toContainText(
    "Shared (conflicted copy).md",
  );
  await expect(page.locator("#status")).not.toContainText("error");
  await expect(editor).toContainText("their line");
  expect(drive.copy()?.name).toBe("Shared (conflicted copy).md");
  expect(drive.copy()?.content).toContain("my line");
  await page.getByRole("button", { name: "Conflicts (1)" }).click();
  const dialog = page.getByRole("dialog", { name: "Sync conflicts" });
  const view = dialog.getByRole("region", { name: "Conflict in Shared.md" });
  await expect(view).toContainText(
    "Choose what to keep for each of the 1 conflicting change(s)",
  );
  return { drive, dialog, view, editor };
}

test("merging a conflicted copy back with both versions syncs the merged note and removes the copy", async ({
  page,
}) => {
  const { drive, dialog, view, editor } = await conflict(page);
  const change = view.getByRole("radiogroup", { name: "Change 1" });
  await expect(view.locator(".merge-local")).toContainText("their line");
  await expect(view.locator(".merge-remote")).toContainText("my line");
  const merge = view.getByRole("button", { name: "Merge copy back" });
  await expect(merge).toBeDisabled();
  await change.getByRole("radio", { name: "Both" }).click();
  await expect(merge).toBeEnabled();
  await merge.click();

  await expect(dialog).toBeHidden();
  await expect(page.locator("#conflicts")).toBeHidden();
  await expect(page.locator("#tree")).not.toContainText("conflicted copy");
  await expect(editor).toContainText("their line");
  await expect(editor).toContainText("my line");

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("#status")).toContainText("Sync finished");
  await expect(page.locator("#status")).not.toContainText("error");
  // The merged note keeps its own id, not the one the copy was given.
  expect(drive.note.content).toMatch(
    /^---\nid: k7f3q2xa\n---\nintro\ntheir line\nmy line\noutro\n$/,
  );
  await expect(page.locator("#tree")).not.toContainText("conflicted copy");
  expect(drive.copy()).toBeUndefined();
});

test("editing the merged text saves exactly what was typed", async ({
  page,
}) => {
  const { dialog, view, editor } = await conflict(page);
  await view.getByRole("button", { name: "Edit merged" }).click();
  const merged = view.getByRole("textbox", { name: "Merged text" });
  await expect(merged).toBeFocused();
  // Cancelling returns to the per-change choices without saving.
  await view.getByRole("button", { name: "Cancel" }).click();
  await expect(merged).toHaveCount(0);
  await expect(
    view.getByRole("radiogroup", { name: "Change 1" }),
  ).toBeVisible();

  await view.getByRole("button", { name: "Edit merged" }).click();
  await merged.fill(`${ID}intro\nhand-merged line\noutro\n`);
  await view.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(editor).toContainText("hand-merged line");
  await expect(editor).not.toContainText("their line");
  await expect(page.locator("#tree")).not.toContainText("conflicted copy");
});

test("keeping both files leaves the copy and clears the conflict", async ({
  page,
}) => {
  const { dialog, view, editor } = await conflict(page);
  await view.getByRole("button", { name: "Keep both files" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#conflicts")).toBeHidden();
  await expect(editor).toContainText("their line");
  await page
    .locator('#tree button[data-path="Shared (conflicted copy).md"]')
    .click();
  await expect(editor).toContainText("my line");
});
