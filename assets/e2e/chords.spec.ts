import { test, expect, type Page } from "@playwright/test";

async function newSequence(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New chord sequence" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#workspace")).toBeEnabled();
}

test("builds, edits and reorders a chord sequence stored as a note", async ({
  page,
}) => {
  const requests: string[] = [],
    frames: string[] = [];
  page.on("request", (r) => requests.push(`${r.url()} ${r.postData() ?? ""}`));
  page.on("websocket", (socket) =>
    socket.on("framesent", (f) => frames.push(String(f.payload))),
  );
  await page.goto("/");
  await newSequence(page, "Song.md");
  const builder = page.getByRole("form", { name: "Chord builder" });
  const sequence = page.getByRole("region", { name: "Chord sequence" });
  await expect(builder).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor" }),
  ).toBeHidden();
  await expect(
    page.locator('#tree [data-path="Song.md"] path'),
  ).toHaveAttribute("d", /^M9 18V5/);

  await builder.getByRole("button", { name: "Add chord" }).click();
  await expect(builder.getByRole("alert")).toContainText("Enter a chord name.");
  await builder.getByLabel("Chord name").fill("C_SENTINEL_7781");
  await builder.getByRole("button", { name: "Mute E2" }).click();
  await builder.getByRole("button", { name: "A2 fret 3", exact: true }).click();
  await builder.getByLabel("Finger for A2").selectOption("3");
  await builder.getByRole("button", { name: "D3 fret 2", exact: true }).click();
  await builder.getByLabel("Finger for D3").selectOption("2");
  await builder.getByRole("button", { name: "Open G3" }).click();
  await builder.getByRole("button", { name: "B3 fret 1", exact: true }).click();
  await builder.getByRole("button", { name: "Open E4" }).click();
  await builder.getByLabel("Tags (comma separated)").fill("open, major");
  await builder.getByRole("button", { name: "Add chord" }).click();
  await expect(sequence.getByRole("listitem")).toHaveCount(1);
  await sequence.getByLabel("Title").fill("Autumn Leaves");
  await sequence.getByLabel("Title").press("Tab");
  await expect(sequence).toContainText("1 C_SENTINEL_7781");
  await expect(
    page.getByRole("status").filter({ hasText: "Saved in this browser" }),
  ).toBeVisible();

  await page.getByRole("radio", { name: "Bass" }).click();
  await expect(
    builder.locator(".string-row").first().locator(".fret"),
  ).toHaveCount(16);
  await expect(
    builder.locator(".string-row .red-line-fret").first(),
  ).toHaveAttribute("aria-label", /fret 12$/);
  await builder.getByLabel("Chord name").fill("E5");
  await builder.getByRole("button", { name: "Open E1" }).click();
  await builder.getByRole("button", { name: "A1 fret 9", exact: true }).click();
  await builder.getByRole("button", { name: "D2 fret 9", exact: true }).click();
  await builder.getByRole("button", { name: "Add chord" }).click();
  await expect(sequence.getByRole("listitem")).toHaveCount(2);

  await sequence
    .getByRole("button", { name: "Duplicate 1 C_SENTINEL_7781" })
    .click();
  await expect(sequence.locator(".chord-item strong")).toHaveText([
    "1 C_SENTINEL_7781",
    "2 C_SENTINEL_7781",
    "1 E5",
  ]);
  await sequence.getByRole("button", { name: "Move 1 E5 up" }).click();
  await sequence
    .getByRole("button", { name: "Delete 2 C_SENTINEL_7781" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(sequence.locator(".chord-item strong")).toHaveText([
    "1 C_SENTINEL_7781",
    "1 E5",
  ]);

  // Unsaved builder changes are confirmed before leaving the note.
  await sequence.getByRole("button", { name: "Edit 1 E5 (bass)" }).click();
  await builder.getByLabel("Chord name").fill("E5 changed");
  await page.getByRole("button", { name: "My notes" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(builder.getByLabel("Chord name")).toHaveValue("E5 changed");
  await builder.getByRole("button", { name: "Save chord" }).click();
  await expect(sequence).toContainText("1 E5 changed");

  await page.getByRole("button", { name: "View as text" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await expect(editor).toContainText("# Autumn Leaves");
  await expect(editor).toContainText("## C_SENTINEL_7781 (guitar)");
  await expect(editor).toContainText("frets: x 3/3 2/2 0 1/1 0");
  await expect(editor).toContainText("tags: open, major");
  await expect(editor).toContainText("## E5 changed (bass)");

  await page.reload();
  await expect(sequence.getByLabel("Title")).toHaveValue("Autumn Leaves");
  await expect(sequence.locator(".chord-item strong")).toHaveText([
    "1 C_SENTINEL_7781",
    "1 E5 changed",
  ]);
  expect(requests.join("\n")).not.toContain("C_SENTINEL_7781");
  expect(frames.join("\n")).not.toContain("C_SENTINEL_7781");
});

test("falls back to text when a chord sequence cannot be read", async ({
  page,
}) => {
  await page.goto("/");
  await newSequence(page, "Broken.md");
  await page.getByRole("button", { name: "View as text" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown editor" });
  await editor.fill(
    "<<<<<<< mine\n## C (guitar)\nfrets: x 3/3 2/2 0 1/1 0\n=======\n>>>>>>> theirs\n",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Saved in this browser" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View chords" }).click();
  await expect(page.locator("#chord-banner")).toContainText(
    "line 1: Expected a chord heading.",
  );
  await expect(editor).toBeVisible();
  await page.reload();
  await expect(page.locator("#chord-banner")).toBeVisible();
  await expect(editor).toContainText("<<<<<<< mine");
  await editor.fill("## C (guitar)\nfrets: x 3/3 2/2 0 1/1 0\n");
  await page.getByRole("button", { name: "View chords" }).click();
  await expect(page.locator("#chord-banner")).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Chord sequence" }),
  ).toContainText("1 C");
});
