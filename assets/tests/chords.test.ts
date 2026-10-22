import { describe, expect, it } from "vitest";
import {
  type Chord,
  chordDisplayNames,
  chordLineEnding,
  emptyStrings,
  fretsText,
  isChordSequence,
  newChordSequenceText,
  parseChordBody,
  serializeChordBody,
  validateChord,
  validateChordSequence,
} from "../js/chords";
import { noteBody, noteId, withBody } from "../js/notemeta";

// Format details are covered by the marknotes-spec fixtures (assets/parity); these test app-side helpers.
const C: Chord = {
  baseName: "C",
  instrument: "guitar",
  strings: [
    { state: "muted" },
    { state: "fretted", fret: 3, finger: 3 },
    { state: "fretted", fret: 2, finger: 2 },
    { state: "open" },
    { state: "fretted", fret: 1, finger: 1 },
    { state: "open" },
  ],
  tags: ["open", "major"],
  note: "Let the top string ring.",
};
const E5: Chord = {
  baseName: "E5",
  instrument: "bass",
  strings: [
    { state: "open" },
    { state: "fretted", fret: 2, finger: 3 },
    { state: "fretted", fret: 2, finger: 4 },
    { state: "muted" },
  ],
  tags: [],
  note: "",
};
const BODY = `# Song

## C (guitar)
frets: x 3/3 2/2 0 1/1 0
tags: open, major

Let the top string ring.

## E5 (bass)
frets: 0 2/3 2/4 x
`;

describe("chord sequence files", () => {
  it("creates a new sequence with an id, the type and an empty body", () => {
    const text = newChordSequenceText();
    expect(text).toMatch(/^---\nid: [0-9a-z]{8}\ntype: chords\n---\n$/);
    expect(isChordSequence(text)).toBe(true);
    expect(noteId(text)).toMatch(/^[0-9a-z]{8}$/);
    expect(noteBody(text)).toBe("");
  });
  it("uses CRLF only when the opening fence does", () => {
    expect(chordLineEnding("---\r\nid: a\r\n---\r\n")).toBe("\r\n");
    expect(chordLineEnding("---  \r\ntype: chords\n---\n")).toBe("\r\n");
    expect(chordLineEnding("---\nid: a\r\n---\r\n")).toBe("\n");
    expect(chordLineEnding("")).toBe("\n");
  });
  it("round-trips a body and keeps the front-matter verbatim", () => {
    const sequence = { title: "Song", chords: [C, E5] };
    expect(parseChordBody(BODY)).toEqual({ sequence, error: null });
    expect(serializeChordBody(sequence, "\n")).toBe(BODY);
    const header = "---\nid: abc\ntype: chords\nextra: yes\n---\n";
    const saved = withBody(header, serializeChordBody(sequence));
    expect(saved.startsWith(header)).toBe(true);
    expect(parseChordBody(noteBody(saved)).sequence).toEqual(sequence);
  });
  it("reports merge conflict markers as a parse error", () => {
    expect(
      parseChordBody("<<<<<<< ours\n## C (guitar)\nfrets: 0 0 0 0 0 0\n").error,
    ).toEqual({ line: 1, message: "Expected a chord heading." });
  });
});

describe("validation and display", () => {
  it("validates single chords for the builder", () => {
    expect(validateChord(C)).toEqual([]);
    expect(validateChord({ ...C, baseName: " " })).toEqual([
      "Enter a chord name.",
    ]);
    expect(validateChord({ ...E5, strings: emptyStrings("bass") })).toEqual([
      "Select at least three non-muted strings.",
    ]);
    expect(validateChord({ ...C, tags: [" a ", "A"] })).toEqual([]);
    expect(
      validateChordSequence({
        title: null,
        chords: [C, { ...C, note: "## x" }],
      }),
    ).toEqual([{ chord: 1, message: 'Note lines cannot start with "## ".' }]);
  });
  it("numbers chords per instrument and name", () => {
    const g = (baseName: string): Chord => ({ ...C, baseName });
    expect(
      chordDisplayNames([g("C"), E5, g("c"), { ...E5, baseName: "C" }]),
    ).toEqual(["1 C", "1 E5", "2 c", "1 C"]);
    expect(fretsText(C.strings)).toBe("x 3/3 2/2 0 1/1 0");
  });
});
