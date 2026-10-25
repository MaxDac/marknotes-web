import { test, expect, type Locator, type Page } from "@playwright/test";
import { docxFixture, pdfFixture } from "./import-fixtures";

const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

async function openImport(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import document" }).click();
  const dialog = page.getByRole("dialog", { name: "Import document" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function drop(
  target: Locator,
  files: { name: string; type: string; text?: string; base64?: string }[],
): Promise<void> {
  await target.evaluate((element, files) => {
    const dataTransfer = new DataTransfer();
    for (const file of files)
      dataTransfer.items.add(
        new File(
          [
            file.base64
              ? Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
              : (file.text ?? ""),
          ],
          file.name,
          { type: file.type },
        ),
      );
    element.dispatchEvent(
      new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }),
    );
  }, files);
}

test("pasted text is auto-formatted, saved in the chosen folder with a unique name, and cancelling keeps the draft", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Work");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("#title")).toContainText("Work");

  let dialog = await openImport(page);
  await expect(
    dialog.getByRole("switch", { name: "Auto-format" }),
  ).toHaveAttribute("aria-checked", "true");
  await dialog
    .getByRole("textbox", { name: "Text to import" })
    .fill("• Private import sentinel");
  await dialog.getByRole("button", { name: "Preview text" }).click();
  await expect(dialog.getByRole("article")).toContainText(
    "Private import sentinel",
  );
  await expect(dialog.getByRole("article").locator("li")).toHaveCount(1);
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue(
    "Private import sentinel",
  );
  await dialog.getByRole("textbox", { name: "Title" }).fill("Imported");
  await expect(dialog.getByLabel("Folder")).toHaveValue("Work");
  await dialog.getByRole("button", { name: "Import note" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#title")).toContainText("Imported.md");
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await expect(editor).toContainText("- Private import sentinel");

  dialog = await openImport(page);
  await dialog.getByLabel("Text to import").fill("• second");
  await dialog.getByRole("switch", { name: "Auto-format" }).click();
  await dialog.getByRole("button", { name: "Preview text" }).click();
  await dialog.getByLabel("Title").fill("IMPORTED");
  await dialog.getByRole("button", { name: "Import note" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#title")).toContainText("IMPORTED 2.md");
  await expect(editor).toContainText("• second");

  await editor.fill("Keep my pending edit");
  dialog = await openImport(page);
  await dialog.getByLabel("Text to import").fill("replacement");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(editor).toHaveText("Keep my pending edit");
  await page.reload();
  await expect(editor).toHaveText("Keep my pending edit");
});

for (const [format, images] of [
  ["html", 1],
  ["docx", 1],
  ["pdf", 0],
] as const)
  test(`${format} is converted in the browser without network access and survives reload`, async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) =>
      requests.push(`${request.url()} ${request.postData() ?? ""}`),
    );
    await page.goto("/");
    const dialog = await openImport(page);
    const buffer =
      format === "docx"
        ? docxFixture()
        : format === "pdf"
          ? pdfFixture()
          : Buffer.from(
              `<h1>HTML private text</h1><img src="data:image/gif;base64,${GIF.toString("base64")}"><img src="https://example.invalid/secret.png" alt="remote"><script>fetch("/leak")</script>`,
            );
    await dialog.getByLabel("Document or images").setInputFiles({
      name: `Example.${format}`,
      mimeType: "application/octet-stream",
      buffer,
    });
    await expect(
      dialog.getByRole("button", { name: "Import note" }),
    ).toBeEnabled();
    const preview = dialog.getByRole("article");
    await expect(preview).toContainText(`${format.toUpperCase()} private text`);
    await expect(preview.locator("img")).toHaveCount(images);
    if (format === "html")
      await expect(
        preview.locator('a[href="https://example.invalid/secret.png"]'),
      ).toHaveCount(1);
    if (format === "pdf")
      await expect(dialog.getByRole("status")).toContainText(
        "Only the text of PDFs",
      );
    await dialog.getByRole("textbox", { name: "Title" }).fill("Example");
    await dialog.getByRole("button", { name: "Import note" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#title")).toContainText("Example.md");
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Markdown editor" }),
    ).toContainText(`${format.toUpperCase()} private text`);
    await expect(page.getByRole("article").locator("img")).toHaveCount(images);
    const sent = requests.join("\n");
    expect(sent).not.toContain("private text");
    expect(sent).not.toContain("example.invalid");
    expect(sent).not.toContain("/leak");
  });

test("a document dropped on the editor opens the import review and keeps the current note", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New note", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Current.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await editor.fill("Existing work survives a document drop");
  await drop(editor, [
    {
      name: "Dropped.md",
      type: "text/markdown",
      text: "# Dropped private note",
    },
  ]);
  const dialog = page.getByRole("dialog", { name: "Import document" });
  await expect(dialog.getByRole("article")).toContainText(
    "Dropped private note",
  );
  await expect(
    dialog.getByRole("switch", { name: "Auto-format" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Import note" }).click();
  await expect(page.locator("#title")).toContainText("Dropped private note.md");
  await page
    .locator("#tree")
    .getByRole("button", { name: "Current.md", exact: true })
    .click();
  await expect(editor).toHaveText("Existing work survives a document drop");
});

test("an image dropped with no note open is imported as a new note", async ({
  page,
}) => {
  await page.goto("/");
  await drop(page.locator("#workspace"), [
    { name: "Picture.gif", type: "image/gif", base64: GIF.toString("base64") },
  ]);
  const dialog = page.getByRole("dialog", { name: "Import document" });
  await expect(dialog.getByRole("article").locator("img")).toHaveCount(1);
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue(
    "Picture",
  );
  await dialog.getByRole("button", { name: "Import note" }).click();
  await expect(page.locator("#title")).toContainText("Picture.md");
  await expect(page.getByRole("article").locator("img")).toHaveCount(1);
});

test("a conversion failure stays visible and cancelling creates no note", async ({
  page,
}) => {
  await page.goto("/");
  const dialog = await openImport(page);
  await dialog.getByLabel("Document or images").setInputFiles({
    name: "broken.docx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a document"),
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "not a valid DOCX document",
  );
  await expect(
    dialog.getByRole("button", { name: "Import note" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#tree")).not.toContainText("broken");
});

test("PDF conversion and its worker work offline", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await context.setOffline(true);
  const dialog = await openImport(page);
  await dialog.getByLabel("Document or images").setInputFiles({
    name: "Offline.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(),
  });
  await expect(
    dialog.getByRole("button", { name: "Import note" }),
  ).toBeEnabled();
  await expect(dialog.getByRole("article")).toContainText("PDF private text");
  await dialog.getByRole("textbox", { name: "Title" }).fill("Offline");
  await dialog.getByRole("button", { name: "Import note" }).click();
  await expect(page.locator("#title")).toContainText("Offline.md");
});
