import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

async function update(page: Page): Promise<() => Promise<void>> {
  const file = new URL("../dist/sw.js", import.meta.url);
  const original = await readFile(file, "utf8");
  await writeFile(
    file,
    `${original}\n// Test release ${crypto.randomUUID()}\n`,
  );
  try {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration!.update();
    });
    await expect(
      page.getByRole("button", { name: "Save and update" }),
    ).toBeVisible();
  } catch (error) {
    await writeFile(file, original);
    throw error;
  }
  return () => writeFile(file, original);
}

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
}
async function create(page: Page, name = "Offline note"): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New note", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#title")).toContainText(name);
}
async function saved(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Markdown editor" }).fill(text);
  await expect(page.locator("#status")).toContainText("Saved in this browser");
}

test("reopens offline, edits existing notes, and serves the security page offline", async ({
  page,
  context,
}) => {
  await ready(page);
  await create(page);
  await saved(page, "Before offline");
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toHaveText("Before offline");
  await expect(page.locator("#connection")).toContainText("Offline");
  await saved(page, "Saved offline");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toHaveText("Saved offline");
  await page.goto("/security");
  await expect(
    page.getByRole("heading", { name: "How MarkNotes protects your notes" }),
  ).toBeVisible();
});

test("editing causes no app-server traffic or socket connections", async ({
  page,
}) => {
  let sockets = 0;
  page.on("websocket", () => sockets++);
  await ready(page);
  await create(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await saved(page, "Private note: never sent to the app server.");
  await page.waitForTimeout(1500);
  expect(requests).toEqual([]);
  expect(sockets).toBe(0);
});

test("public caches exclude OAuth URLs, note text and provider responses", async ({
  page,
}) => {
  await ready(page);
  await create(page);
  await saved(page, "secret-canary-not-for-cache");
  await page.request.get(
    "/oauth/dropbox?code=private-code&state=private-state",
  );
  const entries = await page.evaluate(async () => {
    const entries: { url: string; body: string }[] = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) {
        entries.push({
          url: request.url,
          body: await (await cache.match(request))!.text(),
        });
      }
    }
    return entries;
  });
  expect(entries.length).toBeGreaterThan(5);
  for (const entry of entries) {
    expect(entry.url).not.toMatch(/oauth|dropboxapi|graph\.microsoft|health/);
    expect(entry.body).not.toContain("secret-canary-not-for-cache");
    expect(entry.body).not.toContain("private-code");
  }
});

test("does not disguise unknown navigations or callbacks as the offline app", async ({
  page,
}) => {
  await ready(page);
  expect((await page.goto("/oauth/unknown"))?.status()).toBe(404);
  expect((await page.goto("/missing-route"))?.status()).toBe(404);
  await page.goto("/oauth/dropbox?code=not-rendered");
  await expect(page.locator("body")).toContainText("Open Dropbox sign-in");
  await expect(page.locator("#marknotes")).toHaveCount(0);
});

test("invalid online config fails visibly instead of using a stale cached config", async ({
  page,
}) => {
  await ready(page);
  await page.route("**/config.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: '{"schema":99,"dropbox":"","onedrive":""}',
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid public configuration",
  );
});

test("failed worker registration does not prevent the online editor from starting", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.serviceWorker.register = () =>
      Promise.reject(new Error("Worker download failed"));
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator("#pwa-status")).toContainText(
    "Offline preparation failed",
  );
  await create(page);
  await saved(page, "Still works online");
});

test("the public shell cache can be removed without an old controller repopulating it", async ({
  page,
}) => {
  await ready(page);
  const asset = await page.locator("script[src]").getAttribute("src");
  expect(asset).toMatch(/^\/assets\/.+\.js$/);
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations())
      await registration.unregister();
    for (const key of await caches.keys()) await caches.delete(key);
  });
  await page.evaluate((path) => fetch(path!), asset);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});

test("updates wait for confirmation, save edits and preserve browser data", async ({
  page,
  context,
}) => {
  await ready(page);
  await create(page);
  await saved(page, "Before update");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Sync when reconnected" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  const shellFile = new URL("../dist/index.html", import.meta.url);
  const workerFile = new URL("../dist/sw.js", import.meta.url);
  const shell = await readFile(shellFile, "utf8");
  const worker = await readFile(workerFile, "utf8");
  const release = crypto.randomUUID();
  const updatedShell = shell.replace(
    "<title>MarkNotes</title>",
    `<title>MarkNotes ${release}</title>`,
  );
  const updatedWorker = worker.replace(
    /("revision":")[^"]+(","url":"index\.html")/,
    (_match: string, prefix: string, suffix: string) =>
      `${prefix}${release}${suffix}`,
  );
  expect(updatedShell).not.toBe(shell);
  expect(updatedWorker).not.toBe(worker);
  try {
    await writeFile(shellFile, updatedShell);
    await writeFile(workerFile, updatedWorker);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect(
      page.getByRole("button", { name: "Save and update" }),
    ).toBeVisible();
    await expect(page).toHaveTitle("MarkNotes");
    await expect(
      page.getByRole("textbox", { name: "Markdown editor" }),
    ).toHaveText("Before update");
    await page
      .getByRole("textbox", { name: "Markdown editor" })
      .fill("Saved by update");
    await context.setOffline(true);
    await context.setOffline(false);
    await page.getByRole("button", { name: "Save and update" }).click();
    await expect(
      page.getByRole("textbox", { name: "Markdown editor" }),
    ).toHaveText("Saved by update");
    await expect(
      page.getByRole("button", { name: "Save and update" }),
    ).toHaveCount(0);
    await expect(page).toHaveTitle(`MarkNotes ${release}`);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(
      page.getByRole("switch", { name: "Sync when reconnected" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Done" }).click();
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle(`MarkNotes ${release}`);
    await expect(
      page.getByRole("textbox", { name: "Markdown editor" }),
    ).toHaveText("Saved by update");
  } finally {
    await context.setOffline(false);
    await writeFile(shellFile, shell);
    await writeFile(workerFile, worker);
  }
});

test("updates refuse to interrupt another editing tab", async ({
  page,
  context,
}) => {
  await ready(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("button", { name: "Settings" })).toBeVisible();
  const restore = await update(page);
  try {
    await page.getByRole("button", { name: "Save and update" }).click();
    await expect(page.locator("#pwa-status")).toContainText(
      "Close other MarkNotes tabs",
    );
    await other.close();
    await page.getByRole("button", { name: "Save and update" }).click();
    await expect(
      page.getByRole("button", { name: "Save and update" }),
    ).toHaveCount(0);
  } finally {
    await restore();
  }
});

test("a failed save blocks update activation and leaves the editor usable", async ({
  page,
}) => {
  await ready(page);
  await create(page);
  const restore = await update(page);
  try {
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "notes") throw new Error("Test save failure");
        return put.apply(this, args);
      };
    });
    await page
      .getByRole("textbox", { name: "Markdown editor" })
      .fill("Must not be lost");
    await page.getByRole("button", { name: "Save and update" }).click();
    await expect(page.locator("#pwa-status")).toContainText(
      "Test save failure",
    );
    await expect(
      page.getByRole("textbox", { name: "Markdown editor" }),
    ).toHaveText("Must not be lost");
    await expect(page.locator("#workspace")).toBeEnabled();
    expect(
      await page.evaluate(
        async () =>
          !!(await navigator.serviceWorker.getRegistration())?.waiting,
      ),
    ).toBe(true);
  } finally {
    await restore();
  }
});

test("a missing precache asset fails visibly without breaking online editing", async ({
  page,
}) => {
  const file = new URL("../dist/sw.js", import.meta.url);
  const original = await readFile(file, "utf8");
  const broken = original.replace('"index.html"', '"missing-offline.html"');
  expect(broken === original).toBe(false);
  await writeFile(file, broken);
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(page.locator("#pwa-status")).toContainText(
      "Offline preparation failed",
    );
    await create(page);
    await saved(page, "Online editor survives precache failure");
  } finally {
    await writeFile(file, original);
  }
});

test("encrypted notes still require a passphrase on an offline launch", async ({
  page,
  context,
}) => {
  await ready(page);
  await create(page);
  await saved(page, "Encrypted offline note");
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .locator("#security-settings")
    .getByRole("button", { name: "Lock with a passphrase", exact: true })
    .click();
  await page
    .getByLabel("New passphrase", { exact: true })
    .fill("correct horse battery");
  await page
    .getByLabel("Repeat new passphrase", { exact: true })
    .fill("correct horse battery");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Encrypt and lock" })
    .click();
  await expect(
    page.getByRole("heading", { name: "MarkNotes is locked" }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "MarkNotes is locked" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "Encrypted offline note",
  );
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("correct horse battery");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toHaveText("Encrypted offline note");
});

test("memory-only sessions refuse update reloads and keep the current notes", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .locator("#security-settings")
    .getByRole("button", { name: "Use memory only", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete and use memory only" })
    .click();
  await expect(page.locator(".local")).toContainText("Memory only");
  await create(page);
  await saved(page, "Memory only work");
  const restore = await update(page);
  try {
    await page.getByRole("button", { name: "Save and update" }).click();
    await expect(page.locator("#pwa-status")).toContainText(
      "Memory-only notes would be lost",
    );
    await expect(
      page.getByRole("textbox", { name: "Markdown editor" }),
    ).toHaveText("Memory only work");
  } finally {
    await restore();
  }
});

test("opens pre-overhaul IndexedDB notes and settings without resetting the database", async ({
  page,
}) => {
  await page.goto("/security");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("marknotes", 3);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("notes", { keyPath: "path" });
        request.result.createObjectStore("attachments", { keyPath: "path" });
        for (const name of ["values", "sealed", "meta"])
          request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["notes", "values"], "readwrite");
    tx.objectStore("notes").put({
      path: "Existing.md",
      folder: false,
      text: "---\nid: 3e76f760-3595-4ab3-8616-fb7b5756b44b\n---\n\nExisting unsynced work",
      revision: "old-app-revision",
      modifiedAt: 1700000000000,
    });
    tx.objectStore("values").put("Existing.md", "active-note");
    tx.objectStore("values").put("dark", "theme");
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toContainText("Existing unsynced work");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(async () => {
      const request = indexedDB.open("marknotes");
      return new Promise<number>((resolve) => {
        request.onsuccess = () => {
          const version = request.result.version;
          request.result.close();
          resolve(version);
        };
      });
    }),
  ).toBe(3);
});

test("updates preserve unfinished graphical chord drafts", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("switch", { name: "Create and edit chord sequences" })
    .click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New chord sequence" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Draft sequence");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create" })
    .click();
  const builder = page.getByRole("form", { name: "Chord builder" });
  await builder.getByLabel("Chord name").fill("Unfinished chord");
  const restore = await update(page);
  try {
    await page.getByRole("button", { name: "Save and update" }).click();
    await expect(page.locator("#pwa-status")).toContainText(
      "Add or discard the unfinished chord",
    );
    await expect(builder.getByLabel("Chord name")).toHaveValue(
      "Unfinished chord",
    );
  } finally {
    await restore();
  }
});
