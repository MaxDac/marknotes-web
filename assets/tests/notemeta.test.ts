import { describe, expect, it } from "vitest";
import {
  ID_ALPHABET,
  filterRefs,
  idsToAssign,
  linkedId,
  newId,
  newNoteText,
  noteBody,
  noteId,
  noteLink,
  noteRefs,
  splitFrontMatter,
  withBody,
  withId,
} from "../js/notemeta";

describe("note ids", () => {
  it("uses 8 Crockford base32 lowercase characters", () => {
    for (let i = 0; i < 200; i++) {
      const id = newId();
      expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
      for (const c of id) expect(ID_ALPHABET).toContain(c);
    }
    expect(ID_ALPHABET).toHaveLength(32);
    expect(ID_ALPHABET).not.toMatch(/[ilou]/);
  });
  it("writes new notes with only an id header", () => {
    const text = newNoteText();
    expect(text).toMatch(/^---\nid: [0-9a-z]{8}\n---\n$/);
    expect(noteBody(text)).toBe("");
  });
});

describe("front-matter", () => {
  it("splits header and body, reading quoted or plain ids", () => {
    expect(splitFrontMatter("---\nid: k7f3q2xa\n---\n# Hi\n")).toEqual({
      header: "---\nid: k7f3q2xa\n---\n",
      body: "# Hi\n",
      id: "k7f3q2xa",
    });
    expect(noteId('---\ntags: [a]\nid: "abcd1234"\n---\nx')).toBe("abcd1234");
    expect(noteId("---\r\nid: abcd1234\r\n---\r\nx")).toBe("abcd1234");
    expect(noteBody("---\r\nid: abcd1234\r\n---\r\nx")).toBe("x");
  });
  it("treats text without a closed header as body", () => {
    for (const text of ["# Plain", "---\nid: x", " ---\nid: a\n---\n", ""])
      expect(splitFrontMatter(text)).toEqual({ header: "", body: text });
  });
  it("adds, replaces and preserves other keys verbatim", () => {
    expect(withId("# Body", "abcd1234")).toBe("---\nid: abcd1234\n---\n# Body");
    expect(withId("---\ntitle: X\n---\nB", "abcd1234")).toBe(
      "---\nid: abcd1234\ntitle: X\n---\nB",
    );
    expect(
      withId("---\ntitle: X\nid: old00000\nz: 1\n---\nB", "new11111"),
    ).toBe("---\ntitle: X\nid: new11111\nz: 1\n---\nB");
    expect(withId("---\r\ntitle: X\r\n---\r\nB", "abcd1234")).toBe(
      "---\r\nid: abcd1234\r\ntitle: X\r\n---\r\nB",
    );
  });
  it("re-attaches the hidden header when saving an edited body", () => {
    const text = "---\nid: abcd1234\nkeep: me\n---\nold";
    expect(withBody(text, "new body")).toBe(
      "---\nid: abcd1234\nkeep: me\n---\nnew body",
    );
    expect(withBody("legacy", "new")).toBe("new");
  });
});

describe("note references", () => {
  const notes = [
    { path: "Work/Plan.md", text: "---\nid: aaaa1111\n---\n" },
    { path: "Home/Recipes/Bread.md", text: "---\nid: bbbb2222\n---\n" },
    { path: "Copy.md", text: "---\nid: aaaa1111\n---\n" },
    { path: "Legacy.md", text: "no id" },
  ];
  it("lists titles and full paths, the first duplicate by sorted path winning", () => {
    expect(noteRefs(notes)).toEqual([
      { id: "aaaa1111", path: "Copy.md", title: "Copy", label: "Copy" },
      {
        id: "bbbb2222",
        path: "Home/Recipes/Bread.md",
        title: "Bread",
        label: "Home/Recipes/Bread",
      },
    ]);
    expect([...idsToAssign(notes)].sort()).toEqual([
      "Legacy.md",
      "Work/Plan.md",
    ]);
  });
  it("filters by id prefix or case-insensitive title/path substring", () => {
    const refs = noteRefs(notes);
    expect(filterRefs(refs, "bbbb").map((r) => r.id)).toEqual(["bbbb2222"]);
    expect(filterRefs(refs, "2222")).toEqual([]);
    expect(filterRefs(refs, "recipes/br").map((r) => r.id)).toEqual([
      "bbbb2222",
    ]);
    expect(filterRefs(refs, "COPY").map((r) => r.id)).toEqual(["aaaa1111"]);
    expect(filterRefs(refs, "")).toHaveLength(2);
  });
  it("builds and parses marknotes links", () => {
    expect(noteLink({ id: "abcd1234", title: "A [b]" })).toBe(
      "[A \\[b\\]](marknotes:abcd1234)",
    );
    expect(linkedId("marknotes:abcd1234")).toBe("abcd1234");
    expect(linkedId("https://example.com")).toBeUndefined();
  });
});
