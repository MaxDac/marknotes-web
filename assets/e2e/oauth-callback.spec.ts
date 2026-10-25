import { expect, test, type BrowserContext, type Page } from "./fixtures";

/** Counts token exchanges so each scenario can prove no code was redeemed. */
async function watchTokenExchange(context: BrowserContext) {
  const exchanged: string[] = [];
  await context.route("https://api.dropboxapi.com/oauth2/token", (route) => {
    exchanged.push(route.request().postData() ?? "");
    return route.abort();
  });
  return exchanged;
}

async function connectDropbox(page: Page, context: BrowserContext) {
  await page.goto("/");
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Connect Dropbox" }).click();
  return popup;
}

test("the Dropbox callback opened directly explains how to sign in and drops the code from the URL", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://localhost:4000/"))
      external.push(request.url());
  });
  await page.goto("/oauth/dropbox?code=secret-code&state=secret-state");
  await expect(page.locator("body")).toHaveText(
    "Open Dropbox sign-in from MarkNotes in the original tab, with popups allowed.",
  );
  expect(new URL(page.url()).search).toBe("");
  expect(page.url()).toBe("http://localhost:4000/oauth/dropbox");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
    "content",
    "no-referrer",
  );
  expect(external).toEqual([]);
});

test("the OneDrive callback without a Microsoft response reports that sign-in could not complete", async ({
  page,
}) => {
  await page.goto("/oauth/onedrive");
  await expect(page.locator("body")).toHaveText(
    "Microsoft sign-in could not complete. Close this window and reconnect from MarkNotes.",
  );
});

test("a declined Dropbox consent is reported and no token is requested", async ({
  page,
  context,
}) => {
  const exchanged = await watchTokenExchange(context);
  await context.route(
    "https://www.dropbox.com/oauth2/authorize?**",
    async (route) => {
      const state = new URL(route.request().url()).searchParams.get("state");
      await route.fulfill({
        status: 302,
        headers: {
          location: `http://localhost:4000/oauth/dropbox?error=access_denied&error_description=denied&state=${state}`,
        },
      });
    },
  );
  const popup = await connectDropbox(page, context);
  await expect(page.getByRole("alert")).toContainText(
    "Dropbox sign-in was declined or failed.",
  );
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator("#accounts")).toBeEmpty();
  expect(exchanged).toEqual([]);
});

test("Dropbox sign-in ignores forged messages and reports a closed popup", async ({
  page,
  context,
}) => {
  const exchanged = await watchTokenExchange(context);
  let state = "";
  await context.route(
    "https://www.dropbox.com/oauth2/authorize?**",
    async (route) => {
      state = new URL(route.request().url()).searchParams.get("state") ?? "";
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Dropbox</title><p>Consent screen</p>",
      });
    },
  );
  const popup = await connectDropbox(page, context);
  await expect(popup.getByText("Consent screen")).toBeVisible();
  expect(state).not.toBe("");

  // Another origin (the provider page itself) cannot hand over a code.
  await popup.evaluate(
    (state) =>
      window.opener.postMessage(
        { provider: "dropbox", code: "forged", state },
        "*",
      ),
    state,
  );
  // Nor can a same-origin window that is not the sign-in popup.
  await page.evaluate(
    (state) =>
      window.postMessage(
        { provider: "dropbox", code: "forged", state },
        location.origin,
      ),
    state,
  );
  await page.waitForTimeout(700);
  expect(popup.isClosed()).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await popup.close();
  await expect(page.getByRole("alert")).toContainText(
    "Dropbox sign-in was cancelled or timed out.",
  );
  await expect(page.locator("#accounts")).toBeEmpty();
  expect(exchanged).toEqual([]);
});
