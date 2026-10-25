// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownExamples, showMarkdownHelp } from "../js/help";
import {
  FirstAccessGuide,
  GUIDE_SETTING,
  practice,
  visibleTarget,
} from "../js/onboarding";
import { preview } from "../js/editor";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("isolated practice", () => {
  it("edits and renders without a store, mention handler or image hook", () => {
    const demo = practice();
    document.body.append(demo.root);
    try {
      demo.editor.dispatch({
        changes: {
          from: 0,
          to: demo.editor.state.doc.length,
          insert:
            "# Practice\n\n@private\n\n![remote](https://example.com/pixel)",
        },
      });
      expect(demo.root.querySelector("article h1")?.textContent).toBe(
        "Practice",
      );
      expect(demo.root.querySelector("img")).toBeNull();
      expect(demo.root.querySelector("[data-note-id]")).toBeNull();
      expect(demo.editor.state.readOnly).toBe(false);
      const event = new Event("drop", { bubbles: true, cancelable: true });
      const outside = vi.fn();
      document.body.addEventListener("drop", outside, { once: true });
      demo.editor.contentDOM.dispatchEvent(event);
      expect(outside).not.toHaveBeenCalled();
      document.body.removeEventListener("drop", outside);
    } finally {
      demo.destroy();
    }
  });
  it("does not treat offscreen or hidden nodes as tour anchors", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button hidden id="new">New</button>';
    document.body.append(root);
    expect(visibleTarget(root, "#new")).toBeUndefined();
    expect(visibleTarget(root, "#missing")).toBeUndefined();
  });
});

describe("automatic guide eligibility", () => {
  it("waits while local startup is unavailable without reading or writing preferences", async () => {
    const value = vi.fn();
    const put = vi.fn();
    const guide = new FirstAccessGuide({
      root: document.body,
      store: { value, put },
      available: () => false,
      memoryOnly: false,
      changed: vi.fn(),
      error: vi.fn(),
    });
    guide.start();
    await Promise.resolve();
    guide.destroy();
    expect(value).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
  it("rechecks a handled preference inside the browser lock", async () => {
    const value = vi.fn().mockResolvedValue(true);
    const put = vi.fn();
    const request = vi.fn(async (_name, _options, callback) =>
      callback({ name: "marknotes:onboarding" }),
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    const guide = new FirstAccessGuide({
      root: document.body,
      store: { value, put },
      available: () => true,
      memoryOnly: false,
      changed: vi.fn(),
      error: vi.fn(),
    });
    guide.start();
    await vi.waitFor(() => expect(value).toHaveBeenCalledWith(GUIDE_SETTING));
    guide.destroy();
    expect(request).toHaveBeenCalledWith(
      "marknotes:onboarding",
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(put).not.toHaveBeenCalled();
  });
});

describe("documented Markdown coverage", () => {
  it("renders every help example with the actual preview configuration", () => {
    const rendered = markdownExamples.map((example) => preview(example.source));
    expect(rendered[0]).toContain("<h6>");
    expect(rendered[1]).toContain("<s>");
    expect(rendered[2]).toContain("<blockquote>");
    expect(rendered[3]).toContain('disabled=""');
    expect(rendered[4]).toContain("<table>");
    expect(rendered[5]).toContain("hljs-keyword");
    expect(rendered[6]).toContain("<hr>");
  });
  it("does not advertise unconfigured Markdown extensions", () => {
    const html = preview(
      "https://example.com\n\n$x^2$\n\n[^1]\n\n[^1]: footnote\n\n```mermaid\ngraph TD; A-->B\n```\n\n###### H6\n\n```unknown-language\n<script>x</script>\n```\n\n<b>raw</b>",
    );
    expect(html).not.toContain('<a href="https://example.com"');
    expect(html).not.toContain("katex");
    expect(html).not.toContain('class="footnote');
    expect(html).not.toContain("<svg");
    expect(html).toContain("<h6>H6</h6>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;raw&lt;/b&gt;");
  });
  it("builds a labelled, script-free in-app document", () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    try {
      showMarkdownHelp(vi.fn());
      expect(
        document.querySelector("dialog")?.getAttribute("aria-labelledby"),
      ).toBeTruthy();
      expect(document.querySelectorAll(".markdown-example")).toHaveLength(
        markdownExamples.length,
      );
      expect(document.querySelector("script, iframe, img")).toBeNull();
      expect(document.body.textContent).toContain(
        "Bare URLs are not automatically",
      );
    } finally {
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    }
  });
});
