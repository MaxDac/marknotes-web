import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import MarkdownIt from "markdown-it";
import tasks from "markdown-it-task-lists";
import DOMPurify from "dompurify";
import hljs from "highlight.js";

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: false,
  highlight(code, language): string {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language }).value
      : md.utils.escapeHtml(code);
  },
}).use(tasks);
// Never load note-embedded resources from arbitrary external hosts.
md.renderer.rules.image = (tokens, index) =>
  md.utils.escapeHtml(tokens[index].content);
export function preview(text: string): string {
  return DOMPurify.sanitize(md.render(text), {
    FORBID_TAGS: ["img", "iframe", "form", "style"],
    FORBID_ATTR: ["style", "srcset"],
  });
}
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
): EditorView {
  return new EditorView({
    parent: container,
    state: EditorState.create({
      extensions: [
        editing.of([
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
        ]),
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
