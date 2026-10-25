// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  cycleHeading,
  format,
  mentionAt,
  numberedList,
  preview,
} from "../js/editor";

describe("toolbar commands", () => {
  let view: EditorView;
  const editor = (doc: string, anchor = 0, head = anchor, readOnly = false) =>
    (view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor, head },
        extensions: [EditorState.readOnly.of(readOnly)],
      }),
    }));
  afterEach(() => view.destroy());

  it("cycles the current line through H1, H2, H3 and plain text", () => {
    const view = editor("before\nTitle\nafter", 9);
    for (const prefix of ["# ", "## ", "### ", ""]) {
      cycleHeading(view);
      expect(view.state.doc.toString()).toBe(`before\n${prefix}Title\nafter`);
      expect(view.state.selection.main.head).toBe(9 + prefix.length);
    }
  });
  it("removes H4–H6 headings and preserves backward selections", () => {
    const view = editor("###### Title", 12, 7);
    cycleHeading(view);
    expect(view.state.doc.toString()).toBe("Title");
    expect(view.state.selection.main.anchor).toBe(5);
    expect(view.state.selection.main.head).toBe(0);
  });
  it("places the cursor after a new heading marker", () => {
    const view = editor("");
    cycleHeading(view);
    expect(view.state.doc.toString()).toBe("# ");
    expect(view.state.selection.main.head).toBe(2);
  });
  it("does not treat a hashtag as a heading", () => {
    const view = editor("#tag");
    cycleHeading(view);
    expect(view.state.doc.toString()).toBe("# #tag");
  });
  it("wraps the selected text with strikethrough", () => {
    const view = editor("old text", 0, 3);
    format(view, "~~");
    expect(view.state.doc.toString()).toBe("~~old~~ text");
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(5);
  });
  it("numbers selected lines, converts markers, and toggles off", () => {
    const view = editor("- one\n- [ ] two\n> three\nfour", 0, 21);
    numberedList(view);
    expect(view.state.doc.toString()).toBe("1. one\n2. two\n3. three\nfour");
    numberedList(view);
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree\nfour");
  });
  it("numbers an indented current line even with a cursor inside it", () => {
    const view = editor("  item", 4);
    numberedList(view);
    expect(view.state.doc.toString()).toBe("  1. item");
    expect(view.state.selection.main.head).toBe(7);
  });
  it("keeps blank separator lines and excludes the line after a selection", () => {
    const view = editor("one\n\n two\nnext", 0, 10);
    numberedList(view);
    expect(view.state.doc.toString()).toBe("1. one\n\n 2. two\nnext");
    numberedList(view);
    expect(view.state.doc.toString()).toBe("one\n\n two\nnext");
  });
  it("starts a numbered item on an empty line", () => {
    const view = editor("");
    numberedList(view);
    expect(view.state.doc.toString()).toBe("1. ");
    expect(view.state.selection.main.head).toBe(3);
  });
  it("does not mutate a read-only editor", () => {
    const view = editor("private", 0, 7, true);
    cycleHeading(view);
    numberedList(view);
    expect(view.state.doc.toString()).toBe("private");
  });
});
describe("client-only preview", () => {
  it("renders GFM tables, task lists, strikethrough and code", () => {
    const html = preview(
      "|a|b|\n|-|-|\n|1|2|\n\n~~gone~~\n\n- [x] done\n\n```js\nconst x = 1;\n```",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("hljs-keyword");
  });
  it("does not execute HTML, unsafe links or note-embedded requests", () => {
    const html = preview(
      "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![tracking](https://example.com/pixel)",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<img");
    expect(html).not.toContain('src="https:');
  });
  it("renders only local attachments as images, without a source", () => {
    const path = `attachments/${"b".repeat(64)}.png`;
    const html = preview(`![My photo](${path})\n\n![x](attachments/../x.png)`);
    expect(html).toContain(`data-attachment="${path}"`);
    expect(html).toContain('alt="My photo"');
    expect(html).not.toContain("src=");
    expect(html.match(/<img/g)).toHaveLength(1);
  });
  it("marks note links and flags unresolved ids as broken", () => {
    const html = preview(
      "[Plan](marknotes:aaaa1111) [Gone](marknotes:zzzz9999)",
      { resolve: (id) => id === "aaaa1111" },
    );
    expect(html).toContain(
      'href="#" data-note-id="aaaa1111" class="note-link"',
    );
    expect(html).toMatch(
      /data-note-id="zzzz9999" class="note-link broken" title="Note not found"/,
    );
  });
});

describe("@ mention detection", () => {
  const at = (doc: string, cursor = doc.length) =>
    mentionAt(EditorState.create({ doc, selection: { anchor: cursor } }));
  it("triggers at line start or after whitespace", () => {
    expect(at("@")).toEqual({ from: 0, to: 1, query: "" });
    expect(at("see @pla")).toEqual({ from: 4, to: 8, query: "pla" });
    expect(at("x\n@Work/Plan")).toEqual({
      from: 2,
      to: 12,
      query: "Work/Plan",
    });
    expect(at("see @my note")?.query).toBe("my note");
  });
  it("ignores e-mail addresses, leading spaces and other lines", () => {
    expect(at("me@example.com")).toBeNull();
    expect(at("@ home")).toBeNull();
    expect(at("@abc\nnext")).toBeNull();
  });
});
