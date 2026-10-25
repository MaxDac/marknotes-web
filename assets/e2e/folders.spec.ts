import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/** A Dropbox account that keeps the folders it is asked to create; it records every delete request. */
async function folderDropbox(context: BrowserContext): Promise<string[]> {
  const deletions: string[] = [];
  const folders = new Map<string, object>();
  let manifest = "";
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
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "access-control-allow-origin": "*" },
      });
    const item = (full: string, tag = "folder") => ({
      ".tag": tag,
      id: `id:${full}`,
      name: full.split("/").pop(),
      path_display: full,
      path_lower: full.toLowerCase(),
      ...(tag === "file" ? { rev: "1" } : {}),
    });
    if (path.includes("delete")) deletions.push(req.postData() ?? path);
    if (path.includes("oauth2/token"))
      return reply({
        access_token: "browser-only-token",
        refresh_token: "browser-only-refresh",
        expires_in: 14400,
      });
    if (path.endsWith("get_current_account"))
      return reply({ email: "folders@example.invalid", account_id: "f" });
    if (path.endsWith("create_folder_v2")) {
      const full = (JSON.parse(req.postData() ?? "{}") as { path: string })
        .path;
      if (full !== "/MarkNotes") folders.set(full, item(full));
      return reply({ metadata: item(full) });
    }
    if (path.endsWith("list_folder") || path.endsWith("list_folder/continue"))
      return reply({
        entries: [...folders.values()],
        cursor: "cursor",
        has_more: false,
      });
    if (path.endsWith("upload")) {
      manifest = req.postData() ?? "";
      return reply(item("/MarkNotes/.marknotes/manifest.json", "file"));
    }
    if (path.endsWith("download"))
      return manifest
        ? route.fulfill({ body: manifest })
        : reply({ error_summary: "path/not_found" }, 409);
    return reply({ error: "unexpected provider route" }, 400);
  });
  return deletions;
}

async function sync(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("#status")).toContainText("Sync finished");
}

test("a folder deleted here is kept on Dropbox with a one-time manual-removal notice", async ({
  page,
  context,
}) => {
  const deletions = await folderDropbox(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Dropbox" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.locator("#accounts")).toContainText(
    "folders@example.invalid",
  );
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Work");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#title")).toContainText("Work");
  await sync(page);

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.locator("#tree")).not.toContainText("Work");
  await sync(page);
  const notice = page
    .locator("#accounts")
    .getByRole("status")
    .filter({ hasText: "/MarkNotes/Work" });
  await expect(notice).toContainText("kept on Dropbox");
  expect(deletions).toEqual([]);

  // The notice survives a reload and a repeated sync, without being issued twice.
  await page.reload();
  await sync(page);
  await expect(notice).toHaveCount(1);
  await notice.getByRole("button", { name: "Got it" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await sync(page);
  await expect(page.locator("#accounts").getByRole("status")).toHaveCount(0);
  await expect(page.locator("#tree")).not.toContainText("Work");
  expect(deletions).toEqual([]);
});
