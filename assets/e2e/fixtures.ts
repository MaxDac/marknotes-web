import { test as base, type Page } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Page, BrowserContext, Locator } from "@playwright/test";

/** Existing scenarios dismiss the real guide instead of bypassing production startup. */
export const test = base.extend<{ dismissGuide: void }>({
  dismissGuide: [
    async ({ context }, use) => {
      const install = async (page: Page) => {
        await page.addLocatorHandler(
          page.getByRole("button", { name: "Skip guide" }),
          async (skip) => {
            await skip.click();
          },
        );
      };
      context.on("page", install);
      await Promise.all(context.pages().map(install));
      await use();
      context.off("page", install);
    },
    { auto: true },
  ],
});
