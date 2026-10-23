/** Note front-matter, stable note ids and `marknotes:` note links (see docs/note-format.md). */

export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_LENGTH = 8;

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  // 256 is a multiple of 32, so the modulo keeps the distribution uniform.
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

export interface FrontMatter {
  /** The complete header including both `---` fences and its trailing newline, or "" when absent. */
  header: string;
  body: string;
  id?: string;
}

const FENCE = /^---[ \t]*(\r?\n)/;
const ID_LINE = /^id:[ \t]*(["']?)([^"'\s]+)\1[ \t]*$/m;

export function splitFrontMatter(text: string): FrontMatter {
  const open = FENCE.exec(text);
  if (!open) return { header: "", body: text };
  const rest = text.slice(open[0].length);
  const match = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!match) return { header: "", body: text };
  const end = open[0].length + match.index + match[0].length;
  const header = text.slice(0, end);
  const yaml = rest.slice(0, match.index);
  const id = ID_LINE.exec(yaml)?.[2];
  return { header, body: text.slice(end), ...(id ? { id } : {}) };
}

export const noteBody = (text: string): string => splitFrontMatter(text).body;
export const noteId = (text: string): string | undefined =>
  splitFrontMatter(text).id;

/**
 * Re-attaches a front-matter header to a body. A header that does not end with a line break (`---` at the end of
 * the file) gets one before a non-empty body: CRLF when its opening fence ends with CRLF, LF otherwise.
 */
export function joinFrontMatter(header: string, body: string): string {
  if (!header || !body || header.endsWith("\n")) return header + body;
  const newline = FENCE.exec(header)?.[1] ?? "\n";
  return header + newline + body;
}

/** Replaces the body of `text`, keeping its front-matter header verbatim. */
export function withBody(text: string, body: string): string {
  return joinFrontMatter(splitFrontMatter(text).header, body);
}

/** Sets the note id, preserving every other front-matter key verbatim. */
export function withId(text: string, id: string): string {
  const { header, body } = splitFrontMatter(text);
  if (!header) return `---\nid: ${id}\n---\n${text}`;
  const newline = header.includes("\r\n") ? "\r\n" : "\n";
  const open = FENCE.exec(header)![0];
  const inner = header.slice(open.length);
  const replaced = ID_LINE.test(inner)
    ? inner.replace(ID_LINE, `id: ${id}`)
    : `id: ${id}${newline}${inner}`;
  return open + replaced + body;
}

export const newNoteText = (): string => withId("", newId());

/** File name without the `.md` extension. */
export const noteTitle = (path: string): string =>
  path.split("/").at(-1)!.replace(/\.md$/i, "");

/** Folder path plus title, e.g. `Work/Projects/Plan`. */
export const notePathLabel = (path: string): string =>
  path.replace(/\.md$/i, "");

export interface NoteRef {
  id: string;
  path: string;
  title: string;
  label: string;
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Notes that carry an id, de-duplicated so the first by sorted path wins. */
export function noteRefs(notes: { path: string; text: string }[]): NoteRef[] {
  const seen = new Set<string>(),
    refs: NoteRef[] = [];
  for (const note of [...notes].sort(byPath)) {
    const id = noteId(note.text);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({
      id,
      path: note.path,
      title: noteTitle(note.path),
      label: notePathLabel(note.path),
    });
  }
  return refs;
}

/** Notes whose id must be (re)assigned: missing, or duplicating an earlier note by sorted path. */
export function idsToAssign(
  notes: { path: string; text: string }[],
): Set<string> {
  const seen = new Set<string>(),
    result = new Set<string>();
  for (const note of [...notes].sort(byPath)) {
    const id = noteId(note.text);
    if (!id || seen.has(id)) result.add(note.path);
    else seen.add(id);
  }
  return result;
}

/** Matches an id prefix or a case-insensitive substring of the title or full path. */
export function filterRefs(refs: NoteRef[], query: string): NoteRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return refs;
  return refs.filter(
    (r) =>
      r.id.startsWith(q) ||
      r.title.toLowerCase().includes(q) ||
      r.label.toLowerCase().includes(q),
  );
}

export const NOTE_SCHEME = "marknotes:";

export function noteLink(ref: Pick<NoteRef, "id" | "title">): string {
  const title = ref.title.replace(/[\\[\]]/g, (c) => `\\${c}`);
  return `[${title}](${NOTE_SCHEME}${ref.id})`;
}

export function linkedId(href: string): string | undefined {
  return href.startsWith(NOTE_SCHEME)
    ? href.slice(NOTE_SCHEME.length) || undefined
    : undefined;
}
