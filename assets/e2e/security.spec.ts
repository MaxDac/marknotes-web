import { test, expect, type BrowserContext, type Page } from "./fixtures";

const PASS = "correct horse battery";

async function note(page: Page, name: string, text: string): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#title")).toContainText(
    name.replace(/\.md$/i, ""),
  );
  await page.getByRole("textbox", { name: "Markdown editor" }).fill(text);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved in this browser" }),
  ).toBeVisible();
}
async function settings(page: Page, action: string): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .locator("#security-settings")
    .getByRole("button", { name: action, exact: true })
    .click();
}
/** Raw IndexedDB contents, as an attacker reading the browser profile would see them. */
function disk(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("marknotes");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("open failed"));
    });
    const all = (store: string) =>
      new Promise<unknown[]>((resolve) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result);
      });
    const notes = await all("notes");
    const sealed = (await all("sealed")) as { bytes: ArrayBuffer }[];
    db.close();
    return {
      notes: notes.length,
      sealed: sealed.length,
      text:
        JSON.stringify(notes) +
        sealed
          .map((r) => String.fromCharCode(...new Uint8Array(r.bytes)))
          .join(""),
    };
  });
}
/** A Dropbox account with an empty MarkNotes folder; deletions must never reach it. */
async function fakeDropbox(context: BrowserContext): Promise<string[]> {
  const deletions: string[] = [];
  await context.route(
    "https://www.dropbox.com/oauth2/authorize?**",
    async (route) => {
      const state = new URL(route.request().url()).searchParams.get("state");
      await route.fulfill({
        status: 302,
        headers: {
          location: `http://localhost:4000/oauth/dropbox?code=test-code&state=${state}`,
        },
      });
    },
  );
  await context.route("https://**.dropboxapi.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "access-control-allow-origin": "*" },
      });
    if (path.includes("delete")) deletions.push(path);
    if (path.includes("oauth2/token"))
      return reply({
        access_token: "browser-only-token",
        refresh_token: "browser-only-refresh",
        expires_in: 14400,
      });
    if (path.endsWith("get_current_account"))
      return reply({ email: "wipe@example.invalid", account_id: "wipe" });
    if (path.endsWith("create_folder_v2"))
      return reply({
        metadata: {
          ".tag": "folder",
          id: "folder",
          name: "MarkNotes",
          path_display: "/MarkNotes",
          path_lower: "/marknotes",
        },
      });
    return reply({ entries: [], cursor: "cursor", has_more: false });
  });
  return deletions;
}

async function connectDropbox(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Connect Dropbox" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.locator("#accounts")).toContainText("wipe@example.invalid");
}
async function unlock(page: Page, passphrase: string): Promise<void> {
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
}

test("passphrase lock encrypts notes at rest, unlocks, locks and is removable", async ({
  page,
}) => {
  await page.goto("/");
  await note(page, "Diary.md", "LOCKED_SENTINEL_77");
  await settings(page, "Lock with a passphrase");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New passphrase", { exact: true }).fill(PASS);
  await dialog.getByLabel("Repeat new passphrase").fill("something else!");
  await dialog.getByRole("button", { name: "Encrypt and lock" }).click();
  await expect(dialog.getByRole("alert")).toContainText("do not match");
  await dialog.getByLabel("Repeat new passphrase").fill(PASS);
  await dialog.getByRole("button", { name: "Encrypt and lock" }).click();

  await expect(
    page.getByRole("heading", { name: "MarkNotes is locked" }),
  ).toBeVisible();
  const raw = await disk(page);
  expect(raw.notes).toBe(0);
  expect(raw.sealed).toBeGreaterThan(0);
  expect(raw.text).not.toContain("LOCKED_SENTINEL_77");
  expect(raw.text).not.toContain("Diary");

  await unlock(page, "not the passphrase");
  await expect(page.getByRole("alert")).toContainText("Wrong passphrase");
  await unlock(page, PASS);
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await expect(editor).toContainText("LOCKED_SENTINEL_77");
  await expect(page.locator(".local")).toContainText("encrypted");

  await editor.fill("LOCKED_SENTINEL_78");
  await expect(
    page.getByRole("status").filter({ hasText: "Saved in this browser" }),
  ).toBeVisible();
  expect((await disk(page)).text).not.toContain("LOCKED_SENTINEL_78");

  await page.getByRole("button", { name: "Settings" }).click();
  const security = page.locator("#security-settings");
  await expect(security).toContainText("after 15 minutes");
  await security.getByRole("radio", { name: "Off" }).click();
  await expect(security).toContainText("stays unlocked");
  await page.getByRole("button", { name: "Done" }).click();

  await settings(page, "Lock now");
  await expect(
    page.getByRole("heading", { name: "MarkNotes is locked" }),
  ).toBeVisible();
  await unlock(page, PASS);
  await expect(editor).toContainText("LOCKED_SENTINEL_78");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(security.getByRole("radio", { name: "Off" })).toBeChecked();
  await page.getByRole("button", { name: "Done" }).click();

  await settings(page, "Remove passphrase");
  await page.getByRole("dialog").getByLabel("Current passphrase").fill(PASS);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove passphrase" })
    .click();
  await expect(editor).toContainText("LOCKED_SENTINEL_78");
  await expect(page.locator(".local")).toContainText(
    "stored only in this browser",
  );
  expect((await disk(page)).sealed).toBe(0);
});

test("memory-only mode writes nothing and allows a single tab", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await note(page, "Old.md", "OLD_SENTINEL");
  await settings(page, "Use memory only");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete and use memory only" })
    .click();
  await expect(page.locator(".local")).toContainText("Memory only");
  await expect(page.locator("#tree")).toContainText("No notes yet");

  await note(page, "Temp.md", "MEMORY_SENTINEL");
  const raw = await disk(page);
  expect(raw.notes).toBe(0);
  expect(raw.text).not.toContain("MEMORY_SENTINEL");

  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("alert")).toContainText("another tab");
  await other.close();

  await page.reload();
  await expect(page.locator("#tree")).toContainText("No notes yet");
});

test("forget this device removes every local note", async ({ page }) => {
  await page.goto("/");
  await note(page, "Gone.md", "FORGET_SENTINEL");
  await settings(page, "Forget this device");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Forget this device" })
    .click();
  await expect(page.locator("#tree")).toContainText("No notes yet");
  expect((await disk(page)).text).not.toContain("FORGET_SENTINEL");
});

test("disconnecting the last drive can also delete the notes on this device", async ({
  page,
  context,
}) => {
  const deletions = await fakeDropbox(context);
  await page.goto("/");
  await note(page, "Kept.md", "WIPE_SENTINEL");
  await connectDropbox(page);
  const disconnect = async () => {
    await page
      .getByRole("button", { name: "Options for wipe@example.invalid" })
      .click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    return page.getByRole("dialog", { name: "Disconnect drive?" });
  };
  let dialog = await disconnect();
  const option = dialog.getByLabel(
    "Also delete the notes stored on this device",
  );
  await expect(option).not.toBeChecked();
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#accounts")).toBeEmpty();
  await expect(page.locator('#tree [data-path="Kept.md"]')).toHaveText("Kept");

  await connectDropbox(page);
  dialog = await disconnect();
  await option.check();
  await expect(dialog).toContainText("Nothing is deleted from the drive");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#tree")).toContainText("No notes yet");
  await expect(page.locator("#accounts")).toBeEmpty();
  expect((await disk(page)).text).not.toContain("WIPE_SENTINEL");
  expect(deletions).toEqual([]);
});
test("links to a script-free security page", async ({ page }) => {
  await page.goto("/");
  const link = page
    .locator(".local")
    .getByRole("link", { name: "How your data is protected" });
  await expect(link).toHaveAttribute("href", "/security");
  await expect(link).toHaveAttribute("target", "_blank");
  await page.goto("/security");
  await expect(
    page.getByRole("heading", { name: "How MarkNotes protects your notes" }),
  ).toBeVisible();
  await expect(page.locator("script")).toHaveCount(0);
});
