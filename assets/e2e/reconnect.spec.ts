import { test, expect, type Page, type BrowserContext } from "./fixtures";

async function setting(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Sync when reconnected" });
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled))
    await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

async function reconnect(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
  await context.setOffline(false);
}

async function seed(page: Page, count = 1): Promise<void> {
  await page.evaluate(async (count) => {
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
    const credentials = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const bytes = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          new TextEncoder().encode(
            JSON.stringify({
              access: `fixture-token-${i}`,
              refresh: `fixture-refresh-${i}`,
              expires: Date.now() + 3_600_000,
            }),
          ),
        );
        return { iv, bytes };
      }),
    );
    const tx = db.transaction("values", "readwrite");
    const values = tx.objectStore("values");
    values.put(key, "vault-key");
    values.put(
      credentials.map((_, i) => ({
        id: `drive-${i}`,
        subject: `subject-${i}`,
        label: `drive-${i}@example.invalid`,
        provider: "dropbox",
        folder: "MarkNotes",
      })),
      "accounts",
    );
    credentials.forEach((value, i) =>
      values.put(value, `drive-${i}:credentials`),
    );
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, count);
}

async function fixture(page: Page, context: BrowserContext) {
  const files = new Map<string, string>();
  let snapshots = 0;
  let failure: "none" | "network" | "auth" | "rate" = "none";
  let badTokenOnly = false;
  await context.route("https://**.dropboxapi.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200, headers = {}) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "access-control-allow-origin": "*", ...headers },
      });
    const bad =
      !badTokenOnly || request.headers().authorization?.includes("token-0");
    if (path.endsWith("list_folder") || path.endsWith("list_folder/continue")) {
      snapshots++;
      if (bad && failure === "network")
        return route.abort("internetdisconnected");
      if (bad && failure === "auth") return reply({}, 401);
      if (bad && failure === "rate")
        return reply({}, 429, { "Retry-After": "1" });
      return reply({
        entries: [...files.keys()].map((name) => ({
          ".tag": "file",
          id: name,
          name,
          path_display: `/MarkNotes/${name}`,
          path_lower: `/marknotes/${name.toLowerCase()}`,
          rev: "1",
        })),
        cursor: "fixture-cursor",
        has_more: false,
      });
    }
    if (path.includes("oauth2/token")) return reply({}, 400);
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
    if (path.endsWith("download")) {
      const args = JSON.parse(request.headers()["dropbox-api-arg"]) as {
        path: string;
      };
      const text = files.get(args.path.split("/").at(-1)!);
      return text === undefined
        ? reply({ error_summary: "path/not_found" }, 409)
        : route.fulfill({ body: text });
    }
    if (path.endsWith("upload")) {
      const args = JSON.parse(request.headers()["dropbox-api-arg"]) as {
        path: string;
      };
      const name = args.path.split("/").at(-1)!;
      if (name.endsWith(".md")) files.set(name, request.postData() ?? "");
      return reply({
        ".tag": "file",
        id: name,
        name,
        rev: "1",
        path_display: args.path,
        path_lower: args.path.toLowerCase(),
      });
    }
    return reply({ error: "unexpected fixture route" }, 400);
  });
  await page.goto("/");
  await expect(page.locator("#workspace")).toBeEnabled();
  await expect(page.locator("#pwa-status")).toContainText("ready offline");
  await seed(page);
  return {
    files,
    snapshots: () => snapshots,
    fail: (next: typeof failure, onlyFirst = false) => {
      failure = next;
      badTokenOnly = onlyFirst;
    },
  };
}

test("an offline provider does not block local editing after the guide is handled", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#workspace")).toBeEnabled();
  await expect(page.locator("#accounts")).toContainText(
    "drive-0@example.invalid",
  );
  await page
    .getByRole("button", { name: "Create a note", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Offline local");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Markdown editor" })
    .fill("Saved locally with an offline provider");
  await expect(page.locator("#status")).toHaveText("Saved in this browser");
  expect(drive.snapshots()).toBe(0);
});

test("reconnect is opt-in, saves offline edits first and never sends private data to the app server", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Sync when reconnected" }),
  ).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await reconnect(context);
  expect(drive.snapshots()).toBe(0);
  await setting(page, true);
  await page
    .getByRole("button", { name: "Create a note", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Private.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("#workspace")).toBeEnabled();
  await context.setOffline(true);
  await page
    .getByRole("textbox", { name: "Markdown editor" })
    .fill("RECONNECT_PRIVATE_SENTINEL");
  const appTraffic: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("http://localhost:4000"))
      appTraffic.push(request.url() + (request.postData() ?? ""));
  });
  await context.setOffline(false);
  await expect
    .poll(() => drive.files.get("Private.md"))
    .toContain("RECONNECT_PRIVATE_SENTINEL");
  await expect(page.locator("#status")).toContainText("Sync finished");
  expect(appTraffic.join("\n")).not.toContain("RECONNECT_PRIVATE_SENTINEL");
  await page.reload();
  await expect(page.locator("#workspace")).toBeEnabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Sync when reconnected" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("another tab can opt out and cancel pending reconnect work", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("#workspace")).toBeEnabled();
  await setting(page, true);
  await page.clock.install();
  const baseline = drive.snapshots();
  await reconnect(context);
  await setting(other, false);
  await expect(page.locator("#reconnect-status")).toBeHidden();
  await page.clock.runFor(60_000);
  expect(drive.snapshots()).toBe(baseline);
  await setting(page, false);
});

test("hidden tabs defer until visible and manual sync cancels a pending automatic cycle", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  await page.clock.install();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await reconnect(context);
  await page.clock.runFor(60_000);
  expect(drive.snapshots()).toBe(0);
  await expect(page.locator("#reconnect-status")).toContainText("waiting");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1);
  await expect.poll(drive.snapshots).toBe(1);
  await expect(page.locator("#workspace")).toBeEnabled();
  await reconnect(context);
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Sync finished");
  const afterManual = drive.snapshots();
  await page.clock.runFor(60_000);
  expect(drive.snapshots()).toBe(afterManual);
});

test("lock contention defers safely without freezing controls", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("#workspace")).toBeEnabled();
  await other
    .getByRole("button", { name: "Create a note", exact: true })
    .click();
  await expect(other.getByRole("dialog")).toBeVisible();
  const baseline = drive.snapshots();
  await page.clock.install();
  await reconnect(context);
  await page.clock.runFor(2_000);
  await expect(page.getByRole("alert")).toContainText("Another MarkNotes tab");
  await expect(page.locator("#workspace")).toBeEnabled();
  expect(drive.snapshots()).toBe(baseline);
  await other.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.clock.runFor(5_000);
  await expect.poll(drive.snapshots).toBeGreaterThan(baseline);
});

test("a stale save keeps the draft and prevents automatic provider operations", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  await page
    .getByRole("button", { name: "Create a note", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Stale.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("#workspace")).toBeEnabled();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("#workspace")).toBeEnabled();
  await other
    .getByRole("textbox", { name: "Markdown editor" })
    .fill("Newer saved revision");
  await expect(other.locator("#status")).toHaveText("Saved in this browser");
  await other.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.install();
  await page
    .getByRole("textbox", { name: "Markdown editor" })
    .fill("Unsaved stale draft");
  const before = drive.snapshots();
  await reconnect(context);
  await page.clock.runFor(3_000);
  await expect(page.locator("#status")).toHaveText("Unsaved changes");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toHaveText("Unsaved stale draft");
  await expect(page.locator("#workspace")).toBeEnabled();
  expect(drive.snapshots()).toBe(before);
  expect([...drive.files.values()].join("")).not.toContain(
    "Unsaved stale draft",
  );
});

test("an unfinished chord defers automatic sync until the draft is discarded", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("switch", { name: "Create and edit chord sequences" })
    .click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New chord sequence", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Song.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const builder = page.getByRole("form", { name: "Chord builder" });
  await builder.getByLabel("Chord name").fill("Unfinished chord");
  await page.clock.install();
  await reconnect(context);
  await page.clock.runFor(60_000);
  expect(drive.snapshots()).toBe(0);
  await expect(builder.getByLabel("Chord name")).toHaveValue(
    "Unfinished chord",
  );
  await expect(page.locator("#reconnect-status")).toContainText("waiting");
  await builder.getByRole("button", { name: "Reset", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await page.clock.runFor(1);
  await expect.poll(drive.snapshots).toBe(1);
});

test("locked storage keeps the setting encrypted and does not sync before unlock", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Lock with a passphrase", exact: true })
    .click();
  await page
    .getByLabel("New passphrase", { exact: true })
    .fill("correct horse battery");
  await page.getByLabel("Repeat new passphrase").fill("correct horse battery");
  await page
    .getByRole("button", { name: "Encrypt and lock", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "MarkNotes is locked" }),
  ).toBeVisible();
  const before = drive.snapshots();
  await reconnect(context);
  expect(drive.snapshots()).toBe(before);
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("correct horse battery");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator("#workspace")).toBeEnabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Sync when reconnected" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("memory-only mode does not persist reconnect settings or a private retry queue", async ({
  page,
  context,
}) => {
  await fixture(page, context);
  await setting(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Use memory only", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete and use memory only", exact: true })
    .click();
  await expect(page.locator(".local")).toContainText("Memory only");
  await setting(page, true);
  await page.reload();
  await expect(page.locator("#workspace")).toBeEnabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Sync when reconnected" }),
  ).toHaveAttribute("aria-checked", "false");
  const privateCache = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys())
        urls.push(request.url);
    }
    return urls.some((url) =>
      /dropboxapi|graph\.microsoft|credentials|reconnect/i.test(url),
    );
  });
  expect(privateCache).toBe(false);
});

test("transient failures have finite retries and revoked auth does not loop on new online events", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  await page.clock.install();
  drive.fail("network");
  await reconnect(context);
  for (const [index, delay] of [2_000, 5_000, 15_000, 30_000].entries()) {
    await page.clock.runFor(delay + 100);
    await expect.poll(drive.snapshots).toBe(index + 1);
    await expect(page.locator("#workspace")).toBeEnabled();
    await page.evaluate(() => Promise.resolve());
  }
  await expect(page.locator("#reconnect-status")).toContainText("exhausted");
  expect(drive.snapshots()).toBe(4);
  drive.fail("auth");
  await reconnect(context);
  await page.clock.runFor(2_000);
  await expect(page.getByRole("alert")).toContainText("Reconnect Dropbox");
  expect(context.pages()).toHaveLength(1);
  const afterAuth = drive.snapshots();
  await reconnect(context);
  await page.clock.runFor(60_000);
  expect(drive.snapshots()).toBe(afterAuth);
  drive.fail("none");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Sync finished");
  await reconnect(context);
  await page.clock.runFor(2_000);
  await expect.poll(drive.snapshots).toBeGreaterThan(afterAuth + 1);
});

test("partial multi-drive failures preserve successful drives without retrying auth", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await seed(page, 2);
  drive.fail("auth", true);
  await setting(page, true);
  await page.clock.install();
  await reconnect(context);
  await page.clock.runFor(2_000);
  await expect(page.locator("#status")).toContainText("error");
  await expect(page.locator("#accounts .account-icon.ok")).toHaveCount(1);
  await expect(page.locator("#accounts .account-icon.error")).toHaveCount(1);
  await expect(
    page.locator("#accounts .account:has(.account-icon.ok) .account-synced"),
  ).toContainText("Last sync:");
  await expect(
    page.locator("#accounts .account:has(.account-icon.error) .account-synced"),
  ).toHaveCount(0);
  const previous = drive.snapshots();
  await reconnect(context);
  await page.clock.runFor(2_000);
  await expect.poll(drive.snapshots).toBe(previous + 1);
});

test("rate-limit retries remain bounded across HTTP and reconnect scheduling", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  await page.clock.install();
  drive.fail("rate");
  await reconnect(context);
  for (const [cycle, delay] of [2_000, 5_000, 15_000, 30_000].entries()) {
    await page.clock.runFor(delay + 100);
    await expect.poll(drive.snapshots).toBe(cycle * 4 + 1);
    for (let retry = 1; retry <= 3; retry++) {
      await page.clock.runFor(1_100);
      await expect.poll(drive.snapshots).toBe(cycle * 4 + retry + 1);
    }
    await expect(page.locator("#workspace")).toBeEnabled();
    await page.evaluate(() => Promise.resolve());
  }
  await expect(page.locator("#reconnect-status")).toContainText("exhausted");
  expect(drive.snapshots()).toBe(16);
});

test("forgetting the device cancels a pending reconnect without recreating credentials", async ({
  page,
  context,
}) => {
  const drive = await fixture(page, context);
  await setting(page, true);
  await page.clock.install();
  await reconnect(context);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator("#security-settings")
    .getByRole("button", { name: "Forget this device", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Forget this device", exact: true })
    .click();
  await expect(page.locator("#workspace")).toBeEnabled();
  await expect(page.locator("#accounts .account")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Sync when reconnected" }),
  ).toHaveAttribute("aria-checked", "false");
  expect(drive.snapshots()).toBe(0);
});
