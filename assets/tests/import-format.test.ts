import { describe, expect, it } from "vitest";
import {
  DEFAULT_TITLE,
  looksLikeMarkdown,
  plainTextToMarkdown as md,
  sanitizeTitle,
  suggestTitle,
} from "../js/import-format";

// Cases mirror the Android app's PlainTextToMarkdownTest and ImportConverterTest so both apps format alike.
describe("plainTextToMarkdown", () => {
  it("turns lines into paragraphs and bullets into lists", () => {
    expect(
      md(
        "Shopping for the weekend trip\r\n• Milk\r\n• Bread\r\n   ◦ Rye\r\nThat's all.",
      ),
    ).toBe(
      "Shopping for the weekend trip\n\n- Milk\n- Bread\n    - Rye\n\nThat's all.\n",
    );
  });

  it("converts numbered and task lines", () => {
    expect(md("1) First\n2) Second\n☐ Todo\n☑ Done")).toBe(
      "1. First\n2. Second\n- [ ] Todo\n- [x] Done\n",
    );
  });

  it("turns standalone title lines into headings", () => {
    const text =
      "Meeting Notes\n\nWe discussed the roadmap for the next quarter.\n\n" +
      "ACTION ITEMS\n\n- Send the summary\n\n2.1 Budget Review\n\nNumbers were fine overall.";
    expect(md(text)).toBe(
      "# Meeting Notes\n\nWe discussed the roadmap for the next quarter.\n\n## ACTION ITEMS\n\n" +
        "- Send the summary\n\n### 2.1 Budget Review\n\nNumbers were fine overall.\n",
    );
  });

  it("does not turn sentences or greetings into headings", () => {
    expect(md("Hi there\n\nThanks\n\nJohn")).toBe(
      "Hi there\n\nThanks\n\nJohn\n",
    );
    expect(md("This is a sentence.\n\nAnother one follows here.")).toBe(
      "This is a sentence.\n\nAnother one follows here.\n",
    );
  });

  it("converts setext headings", () => {
    expect(md("Title\n=====\n\nPart\n----\n\nBody")).toBe(
      "# Title\n\n## Part\n\nBody\n",
    );
  });

  it("joins hard-wrapped paragraphs and de-hyphenates", () => {
    const text =
      "This paragraph was wrapped at a fixed width by the\n" +
      "program that produced it, so every line is about the\n" +
      "same length and the sentences continue on the next\n" +
      "line until the end.\n\n" +
      "A second paragraph that is also wrapped by the same\n" +
      "tool and hyphen-\n" +
      "ates a word at the end of a line.";
    expect(md(text)).toBe(
      "This paragraph was wrapped at a fixed width by the program that produced it, so every line is " +
        "about the same length and the sentences continue on the next line until the end.\n\n" +
        "A second paragraph that is also wrapped by the same tool and hyphenates a word at the end " +
        "of a line.\n",
    );
  });

  it("reflows PDF lines", () => {
    expect(md("Short line\njoined with the next.", true)).toBe(
      "Short line joined with the next.\n",
    );
  });

  it("turns indented blocks into code", () => {
    expect(md("Run this:\n\n    npm install\n      npm test")).toBe(
      "Run this:\n\n```\nnpm install\n  npm test\n```\n",
    );
  });

  it("links addresses and escapes Markdown characters", () => {
    expect(
      md("See https://example.com/a_(b), www.x.io and *stars* or file_name."),
    ).toBe(
      "See <https://example.com/a_(b)>, [www.x.io](https://www.x.io) and \\*stars\\* or file_name.\n",
    );
  });

  it("keeps Markdown as it is", () => {
    const text = "# Title\n\nSome **bold** and a [link](https://x.io).\n";
    expect(looksLikeMarkdown(text)).toBe(true);
    expect(md(text)).toBe(text);
    expect(looksLikeMarkdown("Just text with #hashtag and 3 * 4")).toBe(false);
  });

  it("escapes line starts that would become Markdown blocks", () => {
    expect(md("> not a quote\n#hashtag line\n----- dashes")).toBe(
      "\\> not a quote\n\n#hashtag line\n\n----- dashes\n",
    );
  });
});

describe("suggestTitle and sanitizeTitle", () => {
  it("prefers subject, heading, file name, then first line", () => {
    expect(suggestTitle("# Heading", "file.docx", "Shared page")).toBe(
      "Shared page",
    );
    expect(suggestTitle("Intro\n\n## My **Report**", "file.docx")).toBe(
      "My Report",
    );
    expect(suggestTitle("Body", "quarterly-plan.pdf")).toBe("quarterly-plan");
    expect(
      suggestTitle(
        "This is the first line of a rather long text that keeps going on and on",
      ),
    ).toBe("This is the first line of a rather long text that keeps");
    expect(suggestTitle("[Link text](https://x.io) more")).toBe(
      "Link text more",
    );
    expect(suggestTitle("  \n")).toBe(DEFAULT_TITLE);
  });

  it("sanitizes titles into portable names", () => {
    expect(sanitizeTitle("a/b\\c: d")).toBe("a b c d");
    expect(sanitizeTitle("..notes.md")).toBe("notes");
    expect(sanitizeTitle("x".repeat(200))).toBe("x".repeat(80));
  });
});
