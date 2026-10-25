import { button, element, openDialog } from "./components";
import { preview } from "./editor";

export const markdownExamples = [
  {
    title: "Headings and paragraphs",
    source: "# Heading\n\nA paragraph.\n\n###### A smaller heading",
  },
  {
    title: "Emphasis",
    source: "**Bold**, *italic* and ~~strikethrough~~.",
  },
  {
    title: "Lists and quotes",
    source:
      "- A bullet\n- Another item\n\n1. First\n2. Second\n\n> A quotation",
  },
  {
    title: "Tasks",
    source: "- [ ] To do\n- [x] Done",
  },
  {
    title: "Tables",
    source: "| Item | Status |\n| --- | --- |\n| Notes | Ready |",
  },
  {
    title: "Code",
    source: "Use `inline code`.\n\n```js\nconst answer = 42;\n```",
  },
  {
    title: "Links and separators",
    source: "[A website](https://example.com)\n\n---",
  },
] as const;

export const demoText =
  '# Welcome to MarkNotes\n\nTry **bold**, *italic* and ~~strikethrough~~.\n\n## A small plan\n\n- Write an idea\n- Organize your notes\n\n1. Edit the text\n2. Read the preview\n\n- [ ] Try Markdown\n- [x] Open this demo\n\n> This demo is temporary. Changes are not saved.\n\nUse `inline code` or a code block:\n\n```javascript\nconst greeting = "Hello, MarkNotes!";\n```\n\n| View | Purpose |\n| --- | --- |\n| Edit | Write Markdown |\n| Preview | Read formatted text |\n';

export function showMarkdownHelp(back: () => void): void {
  const { body, footer, close } = openDialog(
    "Markdown in MarkNotes Web",
    back,
    "markdown-help",
  );
  body.append(
    element(
      "p",
      "Markdown is plain text with simple punctuation for structure and formatting. You edit the source; Preview shows the formatted result. Your notes remain ordinary .md files.",
    ),
    element("h3", "Syntax you can use"),
  );
  for (const example of markdownExamples) {
    const section = element("section", undefined, "markdown-example");
    const source = element("pre");
    source.append(element("code", example.source));
    const rendered = element("div", undefined, "preview help-preview");
    rendered.setAttribute("aria-label", `${example.title} rendered example`);
    rendered.innerHTML = preview(example.source, { resolve: () => false });
    rendered.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a")) event.preventDefault();
    });
    section.append(element("h4", example.title), source, rendered);
    body.append(section);
  }
  const section = (title: string, text: string) => {
    body.append(element("h3", title), element("p", text));
  };
  section(
    "Toolbar and preview are different",
    "The toolbar inserts bold, italic, strikethrough, headings, links, code, code blocks, bullets, numbered lists, checklists and quotes. Heading cycles H1, H2, H3 and plain text; type H4 through H6 yourself. Tables and horizontal rules are supported by the preview but have no toolbar button. Task checkboxes are read-only in Preview: edit [ ] or [x] in the source. Edit, Split and Preview change the view, not the note.",
  );
  section(
    "Code highlighting",
    "A fenced code block can name a language, such as js. Recognized Highlight.js languages are highlighted; omitted or unrecognized languages display as escaped plain code. Code is never executed.",
  );
  section(
    "Note links and images",
    "In your real notes, type @ to choose a note and insert a stable marknotes: link. Note links require the target note to be present in this browser. Insert image, paste or drop stores local images in attachments/ and syncs them with your notes. Remote image URLs do not load: only their alt text is shown. These features use MarkNotes storage, not extra Markdown syntax plugins. They are intentionally not connected to your notes in the practice demo.",
  );
  section(
    "Limits",
    "This is not a promise of full GitHub Flavored Markdown. Bare URLs are not automatically linked: use [text](https://example.com). Raw HTML is escaped, unsafe links are blocked and remote images are not fetched. There are no math, Mermaid diagram, footnote or emoji-shortcode plugins. Line breaks inside a paragraph normally join; use a blank line for a new paragraph or two trailing spaces for a hard break.",
  );
  section(
    "Chord sequences are separate",
    "Chord sequences are an optional graphical editor enabled in Settings. They are not a Markdown rendering extension. View as text shows their underlying note; ordinary Markdown notes keep the Markdown editor.",
  );
  footer.append(
    button(
      "Back to Help",
      () => {
        close();
        back();
      },
      { variant: "outline" },
    ),
    button("Done", close, { variant: "solid" }),
  );
}

export function showHelp(replay: () => void, memoryOnly: boolean): void {
  const { body, footer, close } = openDialog("Help", () => {});
  body.append(
    element(
      "p",
      "Notes autosave locally in this browser. Drive sync is separate and optional. Offline launch is available after the app reports it is ready offline; sign-in and sync need a connection.",
    ),
    element(
      "p",
      memoryOnly
        ? "Memory-only mode saves no notes or guide preference to disk. The guide can appear again in each new memory-only session."
        : "The first-access guide appears once in this browser profile, including existing profiles. Skip or Finish remembers your choice. Forget this device resets it.",
    ),
    button(
      "Replay first-access guide",
      () => {
        close();
        replay();
      },
      { variant: "outline", id: "replay-guide" },
    ),
    button(
      "What is Markdown?",
      () => {
        close();
        showMarkdownHelp(() => showHelp(replay, memoryOnly));
      },
      { variant: "outline", id: "markdown-help" },
    ),
  );
  footer.append(button("Done", close, { variant: "solid" }));
}
