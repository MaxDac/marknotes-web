import { test, expect, type Page } from "@playwright/test";

const PASS = "correct horse battery";

async function note(page: Page, name: string, text: string): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#title")).toContainText(name);
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

  await settings(page, "Lock now");
  await expect(
    page.getByRole("heading", { name: "MarkNotes is locked" }),
  ).toBeVisible();
  await unlock(page, PASS);
  await expect(editor).toContainText("LOCKED_SENTINEL_78");

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
