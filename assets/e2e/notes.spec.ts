import { test, expect, type Page } from "@playwright/test";
async function submit(page: Page, value: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(value);
  await dialog.getByRole("button", { name: /^(Create|Save)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#title")).toContainText(value);
  await expect(page.locator("#workspace")).toBeEnabled();
}
async function create(
  page: Page,
  kind: "New note" | "New folder",
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: kind }).click();
  await submit(page, name);
}
test("local CRUD, editor, privacy, settings and reload", async ({ page }) => {
  const requests: string[] = [],
    frames: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("http://localhost:4000"))
      requests.push(`${r.url()} ${r.postData() ?? ""}`);
  });
  page.on("websocket", (socket) =>
    socket.on("framesent", (f) => frames.push(String(f.payload))),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "OneDrive: not configured" }),
  ).toBeDisabled();
  await create(page, "New folder", "Work");
  await create(page, "New note", "Private.md");
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await editor.fill("# PRIVATE_SENTINEL_3491\n\n- [x] task\n\n~~old~~");
  await expect(
    page.getByRole("status").filter({ hasText: "Saved in this browser" }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toContainText(
    "PRIVATE_SENTINEL_3491",
  );
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page
    .getByRole("radiogroup", { name: "Accent" })
    .getByRole("radio", { name: "Purple" })
    .click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.reload();
  await expect(editor).toContainText("PRIVATE_SENTINEL_3491");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "purple");
  await page.getByRole("button", { name: "Rename / move" }).click();
  await submit(page, "Renamed.md");
  await expect(page.locator("#tree")).toContainText("Renamed.md");
  expect(requests.join("\n")).not.toContain("PRIVATE_SENTINEL_3491");
  expect(frames.join("\n")).not.toContain("PRIVATE_SENTINEL_3491");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.locator("#tree")).not.toContainText("Renamed.md");
});
test("continues markdown lists and safely renders preview", async ({
  page,
}) => {
  await page.goto("/");
  await create(page, "New note", "List.md");
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await editor.fill("- item");
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("next");
  await expect(editor).toContainText("- next");
  await editor.fill(
    "<script>window.bad = true</script>\n\n![pixel](https://example.com/pixel)",
  );
  await expect(page.locator("#preview img")).toHaveCount(0);
  expect(await page.evaluate(() => "bad" in window)).toBe(false);
});
test("Dropbox PKCE popup and direct browser sync", async ({
  page,
  context,
}) => {
  let revision = 0,
    cloud = "",
    manifest = "";
  const item = (path: string) => ({
    ".tag": "file",
    id: `id:${path}`,
    path_display: `/MarkNotes/${path}`,
    path_lower: `/marknotes/${path.toLowerCase()}`,
    rev: String(revision),
    name: path,
  });
  await context.route(
    "https://www.dropbox.com/oauth2/authorize?**",
    async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const state = url.searchParams.get("state");
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
    if (path.includes("oauth2/token"))
      return reply({
        access_token: "browser-only-token",
        refresh_token: "browser-only-refresh",
        expires_in: 14400,
      });
    if (path.endsWith("get_current_account"))
      return reply({ email: "test@example.invalid", account_id: "test" });
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
    if (path.endsWith("list_folder") || path.endsWith("list_folder/continue"))
      return reply({
        entries: cloud ? [item("Cloud.md")] : [],
        cursor: "cursor",
        has_more: false,
      });
    if (path.endsWith("upload")) {
      const args = JSON.parse(req.headers()["dropbox-api-arg"]) as {
        path: string;
      };
      const body = req.postData() ?? "";
      if (args.path.endsWith("manifest.json")) manifest = body;
      else {
        cloud = body;
        revision++;
      }
      return reply(
        item(
          args.path.endsWith("manifest.json")
            ? ".marknotes/manifest.json"
            : "Cloud.md",
        ),
      );
    }
    if (path.endsWith("download")) {
      const args = JSON.parse(req.headers()["dropbox-api-arg"]) as {
        path: string;
      };
      if (args.path.endsWith("manifest.json"))
        return manifest
          ? route.fulfill({ body: manifest })
          : reply({ error_summary: "path/not_found" }, 409);
      return route.fulfill({ body: cloud });
    }
    return reply({ error: "unexpected provider route" }, 400);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Dropbox" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.locator("#accounts")).toContainText("test@example.invalid");
  await create(page, "New note", "Cloud.md");
  await page
    .getByRole("textbox", { name: "Markdown editor" })
    .fill("browser-only note");
  await expect(page.locator("#status")).toContainText("Saved in this browser");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("#status")).toContainText("Sync finished");
  expect(cloud).toBe("browser-only note");
  expect(JSON.parse(manifest).format).toBe(1);
  cloud = "remote edit";
  revision++;
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toContainText("remote edit");
  await expect(page.locator("#workspace")).toBeEnabled();
  await page
    .getByRole("button", { name: "Options for test@example.invalid" })
    .click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(page.locator("#accounts")).toBeEmpty();
  await expect(page.locator("#tree")).toContainText("Cloud.md");
});

test("OneDrive direct download, guarded writes and newest-wins reconciliation", async ({
  page,
}) => {
  let content = "base note",
    revision = 1,
    modified = "2024-01-01T00:00:00Z",
    copy = "";
  const patches: string[] = [];
  const node = () => ({
    id: "note",
    name: "Shared.md",
    cTag: `c${revision}`,
    eTag: `e${revision}`,
    fileSystemInfo: { lastModifiedDateTime: modified },
    parentReference: { id: "root" },
  });
  const copyNode = {
    id: "copy",
    name: "Shared (conflicted copy).md",
    cTag: "cc1",
    eTag: "ec1",
    parentReference: { id: "root" },
  };
  await page.route("https://graph.microsoft.com/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const reply = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    expect(request.headers().authorization).toBe(
      "Bearer graph-browser-only-token",
    );
    if (url.pathname.endsWith("/root"))
      return reply({ id: "root", name: "root", folder: {} });
    if (
      url.pathname.endsWith("/root/delta") ||
      url.pathname.endsWith("/checkpoint")
    )
      return reply({
        value: [node()],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/checkpoint",
      });
    if (url.pathname.endsWith("/items/note/content")) {
      expect(request.headers()["if-match"]).toBe(`e${revision}`);
      content = request.postData() ?? "";
      revision++;
      return reply(node());
    }
    if (url.pathname.includes("conflicted") && request.method() === "PUT") {
      copy = request.postData() ?? "";
      return reply(copyNode);
    }
    if (request.method() === "PATCH") {
      patches.push(url.pathname.split("/").at(-1)!);
      return reply(url.pathname.endsWith("/items/copy") ? copyNode : node());
    }
    if (url.pathname.endsWith("/items/note"))
      return reply({
        ...node(),
        "@microsoft.graph.downloadUrl":
          "https://download.example.invalid/shared",
      });
    if (url.pathname.includes("manifest.json")) {
      if (request.method() === "PUT")
        return reply({ id: "manifest", name: "manifest.json", eTag: "m1" });
      return reply({}, 404);
    }
    if (url.pathname.endsWith("/children"))
      return reply({
        id: "metadata",
        name: ".marknotes",
        folder: {},
        parentReference: { id: "root" },
      });
    return reply({}, 404);
  });
  await page.route("https://download.example.invalid/shared", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({ body: content });
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
      store = tx.objectStore("values");
    store.put(key, "vault-key");
    store.put({ iv, bytes }, "graph:credentials");
    store.put(
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
  await expect(editor).toContainText("base note");
  await editor.fill("mine");
  await expect(page.locator("#status")).toContainText("Saved in this browser");
  content = "theirs";
  revision++;
  modified = new Date(Date.now() + 60000).toISOString();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("#status")).toContainText(
    "Shared (conflicted copy).md",
  );
  await expect(editor).toContainText("theirs");
  await expect(page.locator("#tree")).toContainText(
    "Shared (conflicted copy).md",
  );
  expect(copy).toBe("mine");
  expect(content).toBe("theirs");
  expect(patches).toContain("copy");
});

test("Dropbox rejects a mismatched OAuth state without exchanging tokens", async ({
  page,
  context,
}) => {
  let exchanged = false;
  await context.route("https://www.dropbox.com/oauth2/authorize?**", (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location:
          "http://localhost:4000/oauth/dropbox?code=bad&state=wrong-state",
      },
    }),
  );
  await context.route("https://api.dropboxapi.com/oauth2/token", (route) => {
    exchanged = true;
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Dropbox" }).click();
  await expect(page.getByRole("alert")).toContainText("state did not match");
  await expect(page.locator("#accounts")).toBeEmpty();
  expect(exchanged).toBe(false);
});

test("menus, dialogs and settings work from the keyboard", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "New", exact: true });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "New note" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "New folder" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.press("Enter");
  await page.getByRole("menuitem", { name: "New note" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "New note" });
  await expect(
    dialog.getByRole("textbox", { name: "Note name" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#tree")).toContainText("No notes yet");

  await trigger.click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByRole("textbox", { name: "Folder name" }).fill("../bad");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.getByRole("textbox", { name: "Folder name" }).fill("Ideas");
  await page.keyboard.press("Enter");
  await expect(page.locator("#title")).toContainText("Ideas");
  await expect(page.locator('#tree button[data-path="Ideas"]')).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.getByRole("button", { name: "Settings" }).click();
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio", { name: "System" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(theme.getByRole("radio", { name: "Light" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
