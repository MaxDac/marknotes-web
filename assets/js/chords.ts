/**
 * Chord sequences: notes with `type: chords` that store guitar and bass chord shapes
 * (spec/note-format.md, "Chord sequences"; ported from MaxDac/ChordBuilder).
 */
import { newId, splitFrontMatter } from "./notemeta";

export type Instrument = "guitar" | "bass";
export const INSTRUMENTS: readonly Instrument[] = ["guitar", "bass"];

/** Open-string tuning per instrument, lowest string first. */
export const TUNINGS: Record<Instrument, readonly string[]> = {
  guitar: ["E2", "A2", "D3", "G3", "B3", "E4"],
  bass: ["E1", "A1", "D2", "G2"],
};

export type StringSelection =
  | { state: "muted" }
  | { state: "open" }
  | { state: "fretted"; fret: number; finger: number };

export interface Chord {
  instrument: Instrument;
  baseName: string;
  /** One entry per string, lowest string first. */
  strings: StringSelection[];
  tags: string[];
  note: string;
}

export interface ChordSequence {
  title: string | null;
  chords: Chord[];
}

export interface ChordParseError {
  /** 1-based line of the body. */
  line: number;
  message: string;
}

export interface ChordValidationError {
  /** 0-based chord index, or null for the title. */
  chord: number | null;
  message: string;
}

export const MAX_FRET = 24;
export const MAX_NAME_LENGTH = 80;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 80;

// The spec's whitespace is ASCII only (U+0009-U+000D and U+0020); String#trim would also strip U+00A0.
const trimAscii = (text: string): string =>
  text.replace(/^[\t-\r ]+|[\t-\r ]+$/g, "");
const isBlank = (line: string): boolean => /^[\t-\r ]*$/.test(line);
const codePoints = (text: string): number => [...text].length;

export const emptyStrings = (instrument: Instrument): StringSelection[] =>
  TUNINGS[instrument].map(() => ({ state: "muted" }));

export const normalizeTitle = (title: string | null): string | null =>
  title === null ? null : trimAscii(title) || null;
export const normalizeBaseName = (name: string): string =>
  trimAscii(name).replace(/[\t-\r ]+/g, " ");
export const normalizeNote = (note: string): string =>
  trimAscii(note.replace(/\r\n/g, "\n"));

/** Trims tags, drops empty ones and removes case-insensitive duplicates, keeping the first spelling. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = trimAscii(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

export const normalizeChord = (chord: Chord): Chord => ({
  instrument: chord.instrument,
  baseName: normalizeBaseName(chord.baseName),
  strings: chord.strings.map((s) => ({ ...s })),
  tags: normalizeTags(chord.tags),
  note: normalizeNote(chord.note),
});

export const normalizeSequence = (sequence: ChordSequence): ChordSequence => ({
  title: normalizeTitle(sequence.title),
  chords: sequence.chords.map(normalizeChord),
});

/** True when the front-matter's first `type` line has the value `chords`. */
export function isChordSequence(text: string): boolean {
  const { header } = splitFrontMatter(text);
  if (!header) return false;
  for (const line of header.split("\n").slice(1)) {
    if (!/^type:[ \t]/.test(line)) continue;
    let value = trimAscii(line.replace(/\r$/, "").slice("type:".length));
    const quoted = /^(["'])(.*)\1$/s.exec(value);
    if (quoted) value = quoted[2]!;
    return value === "chords";
  }
  return false;
}

/** Text of a new, empty chord sequence. */
export const newChordSequenceText = (id: string = newId()): string =>
  `---\nid: ${id}\ntype: chords\n---\n`;

/** The line ending chord bodies are written with: CRLF iff the front-matter opening fence uses it. */
export const chordLineEnding = (text: string): "\n" | "\r\n" =>
  /^---[ \t]*\r\n/.test(text) ? "\r\n" : "\n";

/** Frets token of one string: `x`, `0` or `<fret>/<finger>`. */
export const stringToken = (s: StringSelection): string =>
  s.state === "muted"
    ? "x"
    : s.state === "open"
      ? "0"
      : `${s.fret}/${s.finger}`;

/** Compact `x 3/3 2/2 0 1/1 0` fingering, lowest string first. */
export const fretsText = (strings: readonly StringSelection[]): string =>
  strings.map(stringToken).join(" ");

const HEADING = /^## (.*)\((guitar|bass)\)[ \t]*$/s;

/** Parses a chord-sequence body; returns the normalised sequence or the first error. */
export function parseChordBody(
  body: string,
):
  | { sequence: ChordSequence; error: null }
  | { sequence: null; error: ChordParseError } {
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
  const fail = (index: number, message: string) => ({
    sequence: null,
    error: { line: index + 1, message },
  });
  const nextNonBlank = (from: number): number => {
    let i = from;
    while (i < lines.length && isBlank(lines[i]!)) i++;
    return i;
  };
  let title: string | null = null;
  let i = nextNonBlank(0);
  if (i < lines.length && lines[i]!.startsWith("# ")) {
    title = lines[i]!.slice(2);
    i = nextNonBlank(i + 1);
  }
  if (i < lines.length && !lines[i]!.startsWith("## "))
    return fail(i, "Expected a chord heading.");
  const chords: Chord[] = [];
  while (i < lines.length) {
    const heading = HEADING.exec(lines[i]!);
    if (!heading) return fail(i, "Invalid chord heading.");
    const headingIndex = i;
    const fretsIndex = nextNonBlank(i + 1);
    const fretsLine = lines[fretsIndex];
    if (fretsLine === undefined || !fretsLine.startsWith("frets:"))
      return fail(headingIndex, "Chord has no frets line.");
    const strings: StringSelection[] = [];
    for (const token of fretsLine
      .slice("frets:".length)
      .split(/[ \t]+/)
      .filter(Boolean)) {
      const fretted = /^([0-9]{1,2})\/([0-9])$/.exec(token);
      if (token === "x") strings.push({ state: "muted" });
      else if (token === "0") strings.push({ state: "open" });
      else if (fretted)
        strings.push({
          state: "fretted",
          fret: Number(fretted[1]),
          finger: Number(fretted[2]),
        });
      else return fail(fretsIndex, `Invalid string "${token}".`);
    }
    let noteStart = fretsIndex + 1;
    let tags: string[] = [];
    const tagsIndex = nextNonBlank(noteStart);
    if (lines[tagsIndex]?.startsWith("tags:")) {
      tags = lines[tagsIndex]!.slice("tags:".length).split(",");
      noteStart = tagsIndex + 1;
    }
    i = noteStart;
    while (i < lines.length && !lines[i]!.startsWith("## ")) i++;
    chords.push(
      normalizeChord({
        instrument: heading[2] as Instrument,
        baseName: heading[1]!,
        strings,
        tags,
        note: lines.slice(noteStart, i).join("\n"),
      }),
    );
  }
  return { sequence: { title: normalizeTitle(title), chords }, error: null };
}

/** Writes the canonical body of a sequence (the front-matter is not included). */
export function serializeChordBody(
  sequence: ChordSequence,
  lineEnding: "\n" | "\r\n" = "\n",
): string {
  const { title, chords } = normalizeSequence(sequence);
  const out: string[] = [];
  if (title !== null) out.push(`# ${title}`);
  for (const chord of chords) {
    if (out.length) out.push("");
    out.push(`## ${chord.baseName} (${chord.instrument})`);
    out.push(
      `frets:${chord.strings.map((s) => ` ${stringToken(s)}`).join("")}`,
    );
    if (chord.tags.length) out.push(`tags: ${chord.tags.join(", ")}`);
    else if (chord.note.startsWith("tags:")) out.push("tags:");
    if (chord.note) out.push("", ...chord.note.split("\n"));
  }
  return out.map((line) => line + lineEnding).join("");
}

/** Every validation error of the normalised sequence, in spec order. */
export function validateChordSequence(
  sequence: ChordSequence,
): ChordValidationError[] {
  const { title, chords } = normalizeSequence(sequence);
  const errors: ChordValidationError[] = [];
  if (title !== null && /[\n\r]/.test(title))
    errors.push({ chord: null, message: "Title must be a single line." });
  chords.forEach((chord, index) => {
    for (const message of chordErrors(chord))
      errors.push({ chord: index, message });
  });
  return errors;
}

/** Validation messages of one normalised chord, in spec order. */
function chordErrors(chord: Chord): string[] {
  const errors: string[] = [];
  const add = (failed: boolean, message: string) => {
    if (failed) errors.push(message);
  };
  const fretted = chord.strings.flatMap((s) =>
    s.state === "fretted" ? [s] : [],
  );
  const inRange = (n: number, max: number) =>
    Number.isInteger(n) && n >= 1 && n <= max;
  const strings = TUNINGS[chord.instrument].length;
  add(!chord.baseName, "Enter a chord name.");
  add(
    codePoints(chord.baseName) > MAX_NAME_LENGTH,
    `Chord names must be at most ${MAX_NAME_LENGTH} characters.`,
  );
  add(
    chord.strings.length !== strings,
    `${chord.instrument} requires ${strings} strings.`,
  );
  add(
    chord.strings.filter((s) => s.state !== "muted").length < 3,
    "Select at least three non-muted strings.",
  );
  add(
    fretted.some((s) => !inRange(s.fret, MAX_FRET)),
    `Frets must be between 1 and ${MAX_FRET}.`,
  );
  add(
    fretted.some((s) => !inRange(s.finger, 4)),
    "Fingers must be between 1 and 4.",
  );
  add(
    codePoints(chord.note) > MAX_NOTE_LENGTH,
    `Notes must be at most ${MAX_NOTE_LENGTH} characters.`,
  );
  add(
    chord.note.split("\n").some((line) => line.startsWith("## ")),
    'Note lines cannot start with "## ".',
  );
  add(chord.tags.length > MAX_TAGS, `Use at most ${MAX_TAGS} tags.`);
  add(
    chord.tags.some((tag) => codePoints(tag) > MAX_TAG_LENGTH),
    `Tags must be at most ${MAX_TAG_LENGTH} characters.`,
  );
  add(
    chord.tags.some((tag) => /[,\n\r]/.test(tag)),
    "Tags cannot contain commas or line breaks.",
  );
  return errors;
}

/** Validation messages of one chord (as the builder shows them). */
export const validateChord = (chord: Chord): string[] =>
  chordErrors(normalizeChord(chord));

/** `<sequence> <baseName>` per chord, numbering equal instrument + lowercased name in file order. */
export function chordDisplayNames(
  chords: readonly Pick<Chord, "instrument" | "baseName">[],
): string[] {
  const counts = new Map<string, number>();
  return chords.map((chord) => {
    const name = normalizeBaseName(chord.baseName);
    const key = `${chord.instrument}\u0000${name.toLowerCase()}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return `${n} ${name}`;
  });
}
