/**
 * Plain text to Markdown heuristics and note-title suggestions for imports. Ported from the Android app
 * (marknotes-android `core/importing/PlainTextToMarkdown.kt`, `MarkdownText.kt` and `ImportConverter.kt`) so
 * both apps format the same input the same way.
 */

export const DEFAULT_TITLE = "Imported note";
const MAX_TITLE = 80;
const MAX_FIRST_LINE = 60;
const LIST_INDENT = "    ";
const MAX_LIST_LEVEL = 5;
const MAX_HEADING = 6;
const MAX_HEADING_LENGTH = 70;
const MAX_HEADING_WORDS = 10;
const MIN_CAPS_LETTERS = 3;
const SIGNIFICANT_WORD = 4;
const MIN_SETEXT = 3;
const MIN_WRAPPED_LINES = 3;
const MIN_WRAP_WIDTH = 30;
const MAX_WRAP_WIDTH = 140;
const WRAP_LENGTH_RATIO = 0.6;
const WRAP_SHARE = 0.75;

const BULLET = /^( *)([-*+•·◦▪▫‣⁃●○■□►▶✓✔–—])\s+(\S.*)$/u;
const ORDERED = /^( *)(\d{1,3})[.)]\s+(\S.*)$/;
const TASK = /^( *)(?:[-*•]\s+)?([☐☑☒✅]|\[[ xX]\])\s+(\S.*)$/u;
const SECTION_NUMBER = /^(\d+(?:\.\d+)+)\.?\s+\S/;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const MARKDOWN_SIGNALS = [
  /^#{1,6} \S/m,
  /^(```|~~~)/m,
  /\[[^\]\n]+\]\([^)\s]+\)/,
  /\*\*[^*\n]+\*\*/,
  /^\s*[-*] \[[ xX]\] /m,
  /^\|?\s*:?-{3,}:?\s*\|/m,
];

const isLetter = (c: string) => /\p{L}/u.test(c);
const isLetterOrDigit = (c: string | undefined) =>
  c !== undefined && /[\p{L}\p{Nd}]/u.test(c);
const isUpper = (c: string | undefined) => c !== undefined && /\p{Lu}/u.test(c);
const isLower = (c: string | undefined) => c !== undefined && /\p{Ll}/u.test(c);

/** Line endings, non-breaking and zero-width spaces and the byte order mark normalised. */
export function normalize(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/[\u2028\u2029]/g, "\n");
}

/** Final clean-up: no trailing spaces, at most one blank line in a row, single trailing newline. */
export function tidy(text: string): string {
  const joined = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
  return joined ? `${joined}\n` : "";
}

/** True when `text` already uses Markdown syntax (headings, fences, links, emphasis, tables, task lists). */
export const looksLikeMarkdown = (text: string): boolean =>
  MARKDOWN_SIGNALS.some((signal) => signal.test(text));

/** Escapes characters that would otherwise start inline Markdown constructs. */
export function escapeInline(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("\\`*[]<".includes(c)) out += `\\${c}`;
    else if (c === "_")
      // Intraword underscores (snake_case) can't start emphasis, so they are left alone.
      out +=
        isLetterOrDigit(text[i - 1]) && isLetterOrDigit(text[i + 1])
          ? c
          : "\\_";
    else out += c;
  }
  return out;
}

/** Escapes a line start that would otherwise be read as a heading, quote, list item or rule. */
function escapeLineStart(line: string): string {
  if (
    line.startsWith(">") ||
    /^(#{1,6})(\s|$)/.test(line) ||
    /^([-+])(\s|$)/.test(line) ||
    /^([-=_])\1*\s*$/.test(line)
  )
    return `\\${line}`;
  const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(line);
  return ordered ? `${ordered[1]}\\${line.slice(ordered[1].length)}` : line;
}

const longestRun = (text: string, c: string) =>
  Math.max(
    0,
    ...[...text.matchAll(new RegExp(`\\${c}+`, "g"))].map((m) => m[0].length),
  );

/** Fenced code block for `code`, with a backtick run longer than any inside it. */
export function fence(code: string): string {
  const marker = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  return `${marker}\n${code.replace(/\n+$/, "")}\n${marker}`;
}

const destination = (url: string) =>
  url.trim().replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
const link = (text: string, url: string) =>
  `[${text.trim() || escapeInline(url)}](${destination(url)})`;

/** Drops trailing punctuation from a matched address, keeping closing brackets that are balanced. */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1],
      head = url.slice(0, end);
    const unbalanced =
      c === ")" &&
      (head.match(/\(/g)?.length ?? 0) < (head.match(/\)/g)?.length ?? 0);
    if (".,;:!?'\"".includes(c) || unbalanced) end--;
    else break;
  }
  return url.slice(0, end);
}

/** Escapes Markdown characters and turns bare web addresses into links. */
function inline(text: string): string {
  let out = "",
    last = 0;
  for (const match of text.matchAll(URL)) {
    const url = trimUrl(match[0]);
    out += escapeInline(text.slice(last, match.index));
    out += /^www\./i.test(url)
      ? link(escapeInline(url), `https://${url}`)
      : `<${url}>`;
    last = match.index + url.length;
  }
  return out + escapeInline(text.slice(last));
}

interface ListLine {
  indent: number;
  marker: string;
  text: string;
}
function listItem(line: string): ListLine | null {
  let m = TASK.exec(line);
  if (m) {
    const done = ["☑", "☒", "✅"].includes(m[2]) || /x/i.test(m[2]);
    return {
      indent: m[1].length,
      marker: done ? "- [x] " : "- [ ] ",
      text: m[3],
    };
  }
  m = BULLET.exec(line);
  if (m) return { indent: m[1].length, marker: "- ", text: m[3] };
  m = ORDERED.exec(line);
  if (m)
    return { indent: m[1].length, marker: `${Number(m[2])}. `, text: m[3] };
  return null;
}

type Segment =
  | { kind: "paragraph"; lines: string[]; standalone: boolean }
  | { kind: "item"; level: number; marker: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string };

function expandTabs(line: string): string {
  const indent = /^[ \t]*/.exec(line)![0];
  return indent.replace(/\t/g, "    ") + line.slice(indent.length);
}

function splitBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) blocks.push(current);
      current = [];
    } else current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

/** Wrapped text has many non-final paragraph lines of similar length that don't end a sentence. */
function isHardWrapped(blocks: string[][]): boolean {
  const inner = blocks
    .filter((block) => block.length >= 2)
    .flatMap((block) => block.slice(0, -1))
    .filter((line) => !listItem(line));
  if (inner.length < MIN_WRAPPED_LINES) return false;
  const longest = Math.max(...inner.map((line) => line.length));
  if (longest < MIN_WRAP_WIDTH || longest > MAX_WRAP_WIDTH) return false;
  const similar = inner.filter(
    (line) => line.length >= longest * WRAP_LENGTH_RATIO,
  ).length;
  const open = inner.filter((line) => !/[.:]$/.test(line.trimEnd())).length;
  return (
    similar >= inner.length * WRAP_SHARE && open >= inner.length * WRAP_SHARE
  );
}

function listIndentLevels(lines: string[]): Map<number, number> {
  const indents = [
    ...new Set(
      lines.flatMap((line) => {
        const item = listItem(line);
        return item ? [item.indent] : [];
      }),
    ),
  ].sort((a, b) => a - b);
  return new Map(
    indents.map((indent, index) => [indent, Math.min(index, MAX_LIST_LEVEL)]),
  );
}

function joinWrapped(lines: string[]): string {
  return lines.reduce((acc, line) => {
    const hyphenated =
      acc.length >= 2 && acc.endsWith("-") && isLetter(acc[acc.length - 2]);
    return hyphenated && isLower(line[0])
      ? acc.slice(0, -1) + line
      : `${acc} ${line}`;
  });
}

/** A block that is a single segment as a whole: an indented code block or a setext heading. */
function whole(block: string[]): Segment | null {
  if (
    block.length >= 2 &&
    block.every((line) => line.startsWith("    ")) &&
    !block.some((line) => listItem(line))
  ) {
    const indent = Math.min(
      ...block.map((line) => /^ */.exec(line)![0].length),
    );
    return {
      kind: "code",
      text: block.map((line) => line.slice(indent)).join("\n"),
    };
  }
  if (block.length !== 2 || listItem(block[0])) return null;
  const underline = block[1].trim();
  if (underline.length < MIN_SETEXT) return null;
  if (/^=+$/.test(underline))
    return { kind: "heading", level: 1, text: block[0].trim() };
  if (/^-+$/.test(underline))
    return { kind: "heading", level: 2, text: block[0].trim() };
  return null;
}

function segments(
  block: string[],
  wrapped: boolean,
  levels: Map<number, number>,
): Segment[] {
  const single = whole(block);
  if (single) return [single];
  const result: Segment[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      result.push({ kind: "paragraph", lines: paragraph, standalone: false });
    paragraph = [];
  };
  for (const line of block) {
    const item = listItem(line);
    const last = result.at(-1);
    if (item) {
      flush();
      result.push({
        kind: "item",
        level: levels.get(item.indent) ?? 0,
        marker: item.marker,
        text: item.text.trim(),
      });
    } else if (
      last?.kind === "item" &&
      !paragraph.length &&
      (wrapped || line.startsWith(" "))
    ) {
      last.text = joinWrapped([last.text, line.trim()]);
    } else if (wrapped) {
      paragraph.push(line.trim());
    } else {
      flush();
      paragraph.push(line.trim());
      flush();
    }
  }
  flush();
  if (
    result.length === 1 &&
    result[0].kind === "paragraph" &&
    result[0].lines.length === 1
  )
    result[0].standalone = true;
  return result;
}

function isTitleLike(line: string): boolean {
  const words = line.split(" ").filter(Boolean);
  const letters = [...line].filter(isLetter);
  const plausible =
    line.length <= MAX_HEADING_LENGTH &&
    words.length <= MAX_HEADING_WORDS &&
    letters.length > 0 &&
    !".,;!?".includes(line.at(-1)!) &&
    !new RegExp(URL.source, "i").test(line);
  if (!plausible) return false;
  if (SECTION_NUMBER.test(line)) return true;
  if (letters.length >= MIN_CAPS_LETTERS && !letters.some(isLower)) return true;
  const significant = words.filter(
    (word) => [...word].filter(isLetter).length >= SIGNIFICANT_WORD,
  );
  return (
    isUpper(line[0]) &&
    significant.length > 0 &&
    significant.every((word) => isUpper([...word].find(isLetter)))
  );
}

/** A standalone short line that reads like a title and introduces more content becomes a heading. */
function headingLevel(
  segment: Segment & { kind: "paragraph" },
  index: number,
  all: Segment[],
): number | null {
  if (!segment.standalone) return null;
  const line = segment.lines[0];
  const next = all[index + 1];
  if (!next) return null;
  const introduces =
    next.kind === "paragraph"
      ? joinWrapped(next.lines).length > line.length
      : next.kind !== "heading";
  if (!introduces || !isTitleLike(line)) return null;
  const section = SECTION_NUMBER.exec(line);
  if (section)
    return Math.min((section[1].match(/\./g)?.length ?? 0) + 2, MAX_HEADING);
  return index === 0 ? 1 : 2;
}

function render(all: Segment[]): string {
  let out = "",
    lastWasItem = false;
  const add = (text: string, item: boolean) => {
    if (!text.trim()) return;
    if (out) out += item && lastWasItem ? "\n" : "\n\n";
    out += text.trimEnd();
    lastWasItem = item;
  };
  all.forEach((segment, index) => {
    switch (segment.kind) {
      case "heading":
        add(`${"#".repeat(segment.level)} ${inline(segment.text)}`, false);
        break;
      case "code":
        add(fence(segment.text), false);
        break;
      case "item":
        add(
          LIST_INDENT.repeat(segment.level) +
            segment.marker +
            inline(segment.text),
          true,
        );
        break;
      case "paragraph": {
        const text = joinWrapped(segment.lines);
        const level = headingLevel(segment, index, all);
        add(
          level !== null
            ? `${"#".repeat(level)} ${inline(text.replace(/:+$/, ""))}`
            : escapeLineStart(inline(text)),
          false,
        );
      }
    }
  });
  return out;
}

/**
 * Turns plain text (copied text, `.txt` files, text extracted from PDFs) into Markdown: bullets and numbered lines
 * become lists, standalone title-like lines become headings, indented blocks become code, bare web addresses become
 * links and hard-wrapped paragraphs are re-joined. With `reflow` the lines of a paragraph are always joined (PDF
 * text is wrapped at the page width). Text that already looks like Markdown is kept as it is.
 */
export function plainTextToMarkdown(text: string, reflow = false): string {
  const normalized = normalize(text);
  if (looksLikeMarkdown(normalized)) return tidy(normalized);
  const lines = normalized
    .split("\n")
    .map((line) => expandTabs(line).trimEnd());
  const blocks = splitBlocks(lines);
  const wrapped = reflow || isHardWrapped(blocks);
  const levels = listIndentLevels(lines);
  return tidy(
    render(blocks.flatMap((block) => segments(block, wrapped, levels))),
  );
}

/** Makes `name` a valid, portable note name (without the `.md` extension). */
export function sanitizeTitle(name: string): string {
  let cleaned = name
    .replace(/[/\\:*?"<>|\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (/\.md$/i.test(cleaned)) cleaned = cleaned.slice(0, -3).trim();
  return cleaned.slice(0, MAX_TITLE).replace(/[. ]+$/, "");
}

const stripMarkdown = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\\/g, "");

function shorten(text: string): string {
  if (text.length <= MAX_FIRST_LINE) return text;
  const cut = text.slice(0, MAX_FIRST_LINE);
  const space = cut.lastIndexOf(" ");
  return space > MAX_FIRST_LINE / 2 ? cut.slice(0, space) : cut;
}

/**
 * A note name for imported content: the shared `subject`, else the first heading of `body`, else the `fileName`
 * without extension, else the first line of `body`; cleaned up so it is a valid, portable name.
 */
export function suggestTitle(
  body: string,
  fileName?: string,
  subject?: string,
): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1];
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("!["));
  const base = fileName?.replace(/\.[^.]*$/, "");
  const candidates = [
    subject,
    heading && stripMarkdown(heading),
    fileName && (base?.trim() ? base : fileName),
    firstLine && shorten(stripMarkdown(firstLine)),
  ];
  for (const candidate of candidates) {
    const title = candidate ? sanitizeTitle(candidate) : "";
    if (title) return title;
  }
  return DEFAULT_TITLE;
}
