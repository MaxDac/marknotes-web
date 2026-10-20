// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { preview } from "../js/editor";
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
});
