import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import MarkdownIt, { type Env, type MarkdownIt as Markdown } from "markdown-it";
import tasks from "markdown-it-task-lists";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { isAttachmentPath } from "./attachments";
import { linkedId } from "./notemeta";

const md: Markdown = new MarkdownIt({
  html: false,
  linkify: false,
  highlight(code, language): string {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language }).value
      : md.utils.escapeHtml(code);
  },
}).use(tasks);
export interface PreviewContext extends Env {
  /** Whether a `marknotes:` note id resolves to a note; unresolved links render as broken. */
  resolve?: (id: string) => boolean;
}
// Never load note-embedded resources from arbitrary external hosts: only local attachments render
// as images, and their `src` is set to a local blob URL after sanitizing.
md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index],
    src = String(token.attrGet("src") ?? ""),
    alt = md.utils.escapeHtml(token.content);
  return isAttachmentPath(src)
    ? `<img class="attachment" data-attachment="${src}" alt="${alt}">`
    : alt;
};
const renderLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index],
    id = linkedId(String(token.attrGet("href") ?? ""));
  if (id) {
    const { resolve } = env as PreviewContext;
    token.attrSet("href", "#");
    token.attrSet("data-note-id", id);
    token.attrJoin("class", "note-link");
    if (resolve && !resolve(id)) {
      token.attrJoin("class", "broken");
      token.attrSet("title", "Note not found");
    }
  }
  return renderLinkOpen(tokens, index, options, env, self);
};
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node.nodeName !== "IMG") return;
  if (
    data.attrName === "src" ||
    data.attrName === "srcset" ||
    (data.attrName === "data-attachment" && !isAttachmentPath(data.attrValue))
  )
    data.keepAttr = false;
});
export function preview(text: string, context: PreviewContext = {}): string {
  return DOMPurify.sanitize(md.render(text, context), {
    FORBID_TAGS: ["iframe", "form", "style"],
    FORBID_ATTR: ["style", "srcset"],
  });
}

export interface Mention {
  /** Position of the `@`. */
  from: number;
  to: number;
  query: string;
}
export interface MentionHandler {
  update(mention: Mention | null): void;
  key(key: "up" | "down" | "enter" | "escape"): boolean;
}
/** The `@query` before the cursor when `@` starts a line or follows whitespace. */
export function mentionAt(state: EditorState): Mention | null {
  const selection = state.selection.main;
  if (!selection.empty) return null;
  const line = state.doc.lineAt(selection.head);
  const before = line.text.slice(0, selection.head - line.from);
  const match = /(?:^|\s)@((?:\S[^@]{0,79})?)$/.exec(before);
  if (!match) return null;
  return {
    from: selection.head - match[1].length - 1,
    to: selection.head,
    query: match[1],
  };
}
export interface EditorHooks {
  mention?: MentionHandler;
  /** Image files pasted or dropped into the editor, with the drop position when known. */
  files?: (files: File[], position: number | null) => void;
}
const images = (data: DataTransfer | null): File[] =>
  [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
const editing = new Compartment();
export function setEditorEditable(view: EditorView, value: boolean): void {
  view.dispatch({
    effects: editing.reconfigure([
      EditorView.editable.of(value),
      EditorState.readOnly.of(!value),
    ]),
  });
}
export function createEditor(
  container: HTMLElement,
  changed: (text: string) => void,
  hooks: EditorHooks = {},
): EditorView {
  const { mention, files } = hooks;
  return new EditorView({
    parent: container,
    state: EditorState.create({
      extensions: [
        editing.of([
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
        ]),
        Prec.highest(
          keymap.of(
            (
              [
                ["ArrowDown", "down"],
                ["ArrowUp", "up"],
                ["Enter", "enter"],
                ["Escape", "escape"],
              ] as const
            ).map(([key, name]) => ({
              key,
              run: () => mention?.key(name) ?? false,
            })),
          ),
        ),
        EditorView.domEventHandlers({
          paste(event) {
            const found = images(event.clipboardData);
            if (!files || !found.length) return false;
            event.preventDefault();
            files(found, null);
            return true;
          },
          drop(event, view) {
            const found = images(event.dataTransfer);
            if (!files || !found.length) return false;
            event.preventDefault();
            files(
              found,
              view.posAtCoords({ x: event.clientX, y: event.clientY }),
            );
            return true;
          },
          blur() {
            mention?.update(null);
          },
        }),
        history(),
        markdown(),
        keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Markdown editor",
          spellcheck: "true",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed(update.state.doc.toString());
          if (
            (update.docChanged || update.selectionSet) &&
            update.view.hasFocus
          )
            mention?.update(mentionAt(update.state));
        }),
      ],
    }),
  });
}
export function format(view: EditorView, before: string, after = before): void {
  const { from, to } = view.state.selection.main;
  const selection = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: before + selection + after },
    selection: { anchor: from + before.length, head: to + before.length },
  });
  view.focus();
}

/** Inserts `text` at `position` (or replacing the selection) and places the cursor after it. */
export function insert(
  view: EditorView,
  text: string,
  from = view.state.selection.main.from,
  to = from === view.state.selection.main.from
    ? view.state.selection.main.to
    : from,
): void {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}
