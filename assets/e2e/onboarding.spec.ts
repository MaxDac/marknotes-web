import { test, expect, type Page } from "@playwright/test";

const popover = (page: Page) => page.locator(".driver-popover");
async function skip(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Skip guide" }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator("#marknotes")).not.toHaveClass(/guide-active/);
  await expect(page.locator("#workspace")).toHaveJSProperty("inert", false);
}
async function replay(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("button", { name: "Replay first-access guide" }).click();
  await expect(popover(page)).toBeVisible();
}
async function next(page: Page): Promise<void> {
  await popover(page)
    .getByRole("button", { name: "Next", exact: true })
    .click();
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("marknotes");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result: Record<string, unknown> = {};
    for (const name of ["notes", "attachments", "values", "sealed", "meta"]) {
      const tx = db.transaction(name);
      const store = tx.objectStore(name);
      const keys = store.getAllKeys();
      const values = store.getAll();
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      result[name] = keys.result.flatMap((key, i) =>
        key === "onboarding-handled" ? [] : [[key, values.result[i]]],
      );
    }
    db.close();
    return result;
  });
}
async function removeGuidePreference(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("marknotes");
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("values", "readwrite");
    tx.objectStore("values").delete("onboarding-handled");
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
}

test("new and existing profiles see the guide once, with Skip, replay and Finish", async ({
  page,
}) => {
  await page.route("**/sw.js", (route) => route.abort());
  await page.goto("/");
  await expect(popover(page)).toContainText("Your notes, in your browser");
  await skip(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Help", exact: true }),
  ).toBeVisible();
  await expect(popover(page)).toHaveCount(0);
  await replay(page);
  for (let i = 0; i < 4; i++) await next(page);
  await popover(page).getByRole("button", { name: "Finish" }).click();
  await expect(popover(page)).toHaveCount(0);
  await page.reload();
  await expect(popover(page)).toHaveCount(0);
});

for (const [ending, originalView] of [
  ["Escape", "edit"],
  ["Finish", "preview"],
  ["hidden", "split"],
  ["reload", "split"],
] as const)
  test(`practice is isolated on ${ending} and restores workspace state`, async ({
    page,
  }) => {
    await page.goto("/");
    await skip(page);
    await page
      .getByRole("button", { name: "Create a note", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("Real note");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    const editor = page.getByRole("textbox", {
      name: "Markdown editor",
      exact: true,
    });
    await editor.fill("REAL_NOTE_SENTINEL");
    // Keep the final keystroke in a separate CodeMirror undo group.
    await page.waitForTimeout(600);
    await editor.press("End");
    await editor.press("x");
    await expect(page.locator("#status")).toHaveText("Saved in this browser");
    await editor.press("Home");
    await editor.press("ArrowRight");
    await editor.press("Shift+ArrowRight");
    const selection = await page.evaluate(() =>
      document.getSelection()?.toString(),
    );
    expect(selection).toBe("E");
    await page
      .getByRole("radiogroup", { name: "View", exact: true })
      .getByRole("radio", {
        name: originalView[0].toUpperCase() + originalView.slice(1),
        exact: true,
      })
      .click();
    const before = await snapshot(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await replay(page);
    await next(page);
    await next(page);
    const practice = page.getByRole("textbox", {
      name: "Practice Markdown editor",
      exact: true,
    });
    await practice.fill("");
    await expect(
      page.getByRole("heading", { name: "Demo - changes are not saved" }),
    ).toBeVisible();
    await practice.fill(
      "# DEMO_ONLY\n\n@real\n\n![x](https://example.com/pixel)",
    );
    await expect(
      page.getByRole("article", { name: "Practice preview" }),
    ).toContainText("DEMO_ONLY");
    await page.getByRole("button", { name: "Practice bold" }).click();
    const views = page.getByRole("radiogroup", { name: "Practice view" });
    await views.getByRole("radio", { name: "Preview", exact: true }).click();
    await expect(practice).toBeHidden();
    await views.getByRole("radio", { name: "Edit", exact: true }).click();
    await expect(practice).toBeVisible();
    await practice.evaluate((node) => {
      const files = new DataTransfer();
      files.items.add(
        new File(["not an image"], "demo.png", { type: "image/png" }),
      );
      node.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: files,
        }),
      );
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: files,
        }),
      );
    });
    const outsideDropCancelled = await page.evaluate(
      () =>
        !document.body.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: new DataTransfer(),
          }),
        ),
    );
    expect(outsideDropCancelled).toBe(true);
    expect(requests).toEqual([]);
    if (ending === "Escape") await page.keyboard.press("Escape");
    else if (ending === "Finish") {
      await next(page);
      await next(page);
      await popover(page).getByRole("button", { name: "Finish" }).click();
    } else if (ending === "hidden") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } else await page.reload();
    await expect(popover(page)).toHaveCount(0);
    expect(await snapshot(page)).toEqual(before);
    if (ending !== "reload") {
      expect(requests).toEqual([]);
      await expect(page.locator("#main")).toHaveAttribute(
        "data-view",
        originalView,
      );
      await expect(
        page.getByRole("button", { name: "Help", exact: true }),
      ).toBeFocused();
      await page
        .getByRole("radiogroup", { name: "View", exact: true })
        .getByRole("radio", { name: "Edit", exact: true })
        .click();
      await editor.focus();
      await expect
        .poll(() => page.evaluate(() => document.getSelection()?.toString()))
        .toBe(selection);
      await expect(editor).toHaveText("REAL_NOTE_SENTINELx");
      await editor.press("Control+z");
      await expect(editor).toHaveText("REAL_NOTE_SENTINEL");
    } else await expect(editor).toHaveText("REAL_NOTE_SENTINELx");
    await expect(page.locator(".guide-practice")).toHaveCount(0);
  });

test("Help and replay work offline without documentation or tracking requests", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await skip(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Help", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("button", { name: "What is Markdown?" }).click();
  await expect(
    page.getByRole("heading", { name: "Markdown in MarkNotes Web" }),
  ).toBeVisible();
  await expect(page.locator(".markdown-example table")).toBeVisible();
  await page.getByRole("link", { name: "A website" }).click();
  await expect(
    page.getByRole("heading", { name: "Markdown in MarkNotes Web" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to Help" }).click();
  await page.getByRole("button", { name: "Replay first-access guide" }).click();
  await skip(page);
  expect(requests).toEqual([]);
});

test("mobile and reduced motion have visible anchors, keyboard dismissal and restored sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await next(page);
  await expect(page.locator("#marknotes")).toHaveClass(/sidebar-open/);
  const target = await page.locator("#new").boundingBox();
  expect(target?.x).toBeGreaterThanOrEqual(0);
  await expect(popover(page)).not.toHaveClass(/driver-fade/);
  await page.keyboard.press("Tab");
  await expect(popover(page).locator(":focus")).toHaveCount(1);
  await next(page);
  await expect(
    page.getByRole("textbox", { name: "Practice Markdown editor" }),
  ).toBeVisible();
  const box = await popover(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator("#marknotes")).not.toHaveClass(/sidebar-open/);
});

test("only one plain-storage tab automatically runs the guide", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(popover(page)).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(
    other.getByRole("button", { name: "Help", exact: true }),
  ).toBeVisible();
  await expect(popover(other)).toHaveCount(0);
  await skip(page);
  await other.waitForTimeout(1200);
  await expect(popover(other)).toHaveCount(0);
});

test("interrupted guide is not handled, and an existing profile is eligible without modifying notes", async ({
  page,
}) => {
  await page.goto("/");
  await expect(popover(page)).toBeVisible();
  await page.reload();
  await expect(popover(page)).toBeVisible();
  await skip(page);
  await page
    .getByRole("button", { name: "Create a note", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Existing");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .fill("EXISTING_CONTENT");
  await expect(page.locator("#status")).toHaveText("Saved in this browser");
  await removeGuidePreference(page);
  await page.reload();
  await expect(popover(page)).toBeVisible();
  await skip(page);
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveText("EXISTING_CONTENT");
});

test("memory-only completion stays off disk and recurs after reload", async ({
  page,
}) => {
  await page.goto("/");
  await skip(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("button", { name: "Use memory only", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete and use memory only" })
    .click();
  await expect(popover(page)).toContainText("Memory-only");
  const before = await snapshot(page);
  await skip(page);
  expect(await snapshot(page)).toEqual(before);
  const marker = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("marknotes");
      request.onsuccess = () => resolve(request.result);
    });
    const request = db
      .transaction("values")
      .objectStore("values")
      .get("onboarding-handled");
    const result = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return result;
  });
  expect(marker).toBeUndefined();
  await page.reload();
  await expect(popover(page)).toBeVisible();
  await skip(page);
});

test("Forget resets completion from a persistent plain profile", async ({
  page,
}) => {
  await page.goto("/");
  await skip(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Help", exact: true }),
  ).toBeVisible();
  await expect(popover(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("button", { name: "Forget this device", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Forget this device", exact: true })
    .click();
  await expect(popover(page)).toBeVisible();
});

test("locked profiles wait for unlock and keep the guide preference encrypted", async ({
  page,
}) => {
  await page.goto("/");
  await skip(page);
  await removeGuidePreference(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("button", { name: "Lock with a passphrase", exact: true })
    .click();
  await page
    .getByLabel("New passphrase", { exact: true })
    .fill("test guide passphrase");
  await page.getByLabel("Repeat new passphrase").fill("test guide passphrase");
  await page.getByRole("button", { name: "Encrypt and lock" }).click();
  await expect(
    page.getByRole("heading", { name: "MarkNotes is locked" }),
  ).toBeVisible();
  await expect(popover(page)).toHaveCount(0);
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("test guide passphrase");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(popover(page)).toBeVisible();
  await skip(page);
  const raw = await snapshot(page);
  expect(raw.notes).toEqual([]);
  expect(JSON.stringify(raw.values)).not.toContain("onboarding");
  expect(JSON.stringify(raw.meta)).not.toContain("onboarding");
  expect(raw.sealed).not.toEqual([]);
});

test("a failed handled preference write stays visible and can be retried", async ({
  page,
}) => {
  await page.goto("/");
  await expect(popover(page)).toBeVisible();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    let fail = true;
    window.addEventListener("allow-guide-write", () => {
      fail = false;
    });
    IDBObjectStore.prototype.put = function (value, key) {
      if (key === "onboarding-handled" && fail)
        throw new DOMException("Test storage failure", "QuotaExceededError");
      return put.call(this, value, key);
    };
  });
  await page.getByRole("button", { name: "Skip guide" }).click();
  await expect(popover(page).getByRole("alert")).toContainText(
    "Could not remember",
  );
  await expect(page.locator("#workspace")).toHaveJSProperty("inert", true);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("allow-guide-write")),
  );
  await skip(page);
});
