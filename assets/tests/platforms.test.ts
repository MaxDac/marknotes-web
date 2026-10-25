// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { OTHER_PLATFORMS, platformLinks } from "../js/platforms";

describe("links to other MarkNotes platforms", () => {
  it("lists Android, Android Plus and Desktop but not the web app", () => {
    const links = [...platformLinks().querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      [
        "MarkNotes for Android (F-Droid)",
        "https://f-droid.org/packages/io.github.maxdac.marknotes.libre/",
      ],
      [
        "MarkNotes Plus for Android (GitHub Releases)",
        "https://github.com/MaxDac/MarkNotes/releases",
      ],
      [
        "MarkNotes Desktop (GitHub Releases)",
        "https://github.com/MaxDac/marknotes-electron/releases",
      ],
    ]);
    expect(OTHER_PLATFORMS).toHaveLength(3);
    expect(
      OTHER_PLATFORMS.some((p) => p.url.includes("marknotes.fly.dev")),
    ).toBe(false);
  });
  it("opens in a new tab without opener, referrer or tracking", () => {
    for (const a of platformLinks().querySelectorAll("a")) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
      const url = new URL(a.href);
      expect(url.protocol).toBe("https:");
      expect(url.search).toBe("");
      expect(url.pathname).not.toContain("/releases/latest");
    }
  });
});
