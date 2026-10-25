import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const SECRET = "PRIVATE_NOTE_PATH_ID_TOKEN_STACK";
async function error(page: Page): Promise<void> {
  await page.evaluate((secret) => {
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: secret,
        filename: secret,
        error: new Error(secret),
      }),
    );
  }, SECRET);
  await expect
    .poll(() => state(page).then((s) => s?.records.length))
    .toBeGreaterThan(0);
}
function state(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("marknotes");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<
        { records: unknown[]; snapshot?: unknown } | undefined
      >((resolve, reject) => {
        const request = db
          .transaction("values")
          .objectStore("values")
          .get("diagnostics");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test("local errors persist sanitized, export offline, and clear both logs and snapshot", async ({
  page,
  context,
}) => {
  const unexpected: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(SECRET)) unexpected.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("#settings")).toBeVisible();
  await error(page);
  expect(JSON.stringify(await state(page))).not.toContain(SECRET);
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await context.setOffline(true);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export logs" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("marknotes-diagnostics.json");
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain("uncaught-error");
  expect(exported).not.toContain(SECRET);
  expect(JSON.parse(exported).records).toEqual((await state(page))!.records);
  expect(await state(page)).toHaveProperty("snapshot");
  await page.getByRole("button", { name: "Clear logs" }).click();
  await expect.poll(() => state(page)).toBeUndefined();
  expect(unexpected).toEqual([]);
});

test("report shows exact excerpt and transmission warning; only consent opens a web draft", async ({
  page,
  context,
}) => {
  let githubRequests = 0;
  await context.route(
    "https://github.com/MaxDac/marknotes-web/issues/new?**",
    async (route) => {
      githubRequests++;
      await route.fulfill({
        contentType: "text/html",
        body: "<p>GitHub issue draft fixture</p>",
      });
    },
  );
  await page.goto("/");
  await expect(page.locator("#settings")).toBeVisible();
  await error(page);
  await page.getByRole("button", { name: "Settings" }).click();
  expect(githubRequests).toBe(0);
  await page.getByRole("button", { name: "Report a problem" }).click();
  const review = page.getByRole("dialog");
  await expect(review).toContainText("before you submit");
  await expect(review).toContainText("browser history");
  await expect(review).toContainText("uncaught-error");
  await expect(review).not.toContainText(SECRET);
  const link = review.getByRole("button", { name: "Open GitHub draft" });
  await expect(link).toHaveAttribute("aria-disabled", "true");
  await expect(link).not.toHaveAttribute("href");
  expect(githubRequests).toBe(0);
  await review.getByRole("button", { name: "Cancel" }).click();
  expect(githubRequests).toBe(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await review.getByRole("checkbox").check();
  const url = (await link.getAttribute("href"))!;
  expect(url.length).toBeLessThanOrEqual(2000);
  expect(url).toMatch(/^[\x20-\x7e]+$/);
  expect(new URL(url).searchParams.get("body")).toBe(
    await review.locator("pre").textContent(),
  );
  const popup = page.waitForEvent("popup");
  await link.click();
  const opened = await popup;
  await expect(opened.locator("body")).toContainText(
    "GitHub issue draft fixture",
  );
  expect(githubRequests).toBe(1);
});

test("forget device removes diagnostics and export snapshots without reporting", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#settings")).toBeVisible();
  await error(page);
  await page.getByRole("button", { name: "Settings" }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export logs" }).click();
  await downloaded;
  await page
    .getByRole("button", { name: "Forget this device", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Forget this device", exact: true })
    .click();
  await expect(page.locator("#settings")).toBeVisible();
  await expect
    .poll(() => state(page).then((s) => s?.records ?? []))
    .toEqual([]);
  expect(await state(page)).not.toHaveProperty("snapshot");
});
