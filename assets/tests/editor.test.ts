// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { mentionAt, preview } from "../js/editor";
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
