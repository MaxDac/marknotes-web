// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  ChordEditor,
  chordPreview,
  fretRange,
  previewStart,
} from "../js/chord-editor";
import { type Chord, type ChordSequence } from "../js/chords";

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
  tags: [],
  note: "",
};

function mount(confirm = vi.fn(async () => true)) {
  const onChange = vi.fn<(sequence: ChordSequence) => void>();
  const editor = new ChordEditor({ onChange, confirm });
  document.body.replaceChildren(editor.root);
  const q = <T extends HTMLElement>(selector: string) =>
    editor.root.querySelector<T>(selector)!;
  const label = (name: string) =>
    q<HTMLButtonElement>(`[aria-label="${name}"], [data-value="${name}"]`);
  const type = (selector: string, value: string) => {
    const input = q<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };
  const submit = () =>
    q<HTMLFormElement>(".chord-form").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
  return { editor, onChange, confirm, q, label, type, submit };
}
const seq = (...chords: Chord[]): ChordSequence => ({ title: null, chords });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("fretboard", () => {
  it("shows frets 1-24 on guitar and 9-24 on bass", () => {
    expect(fretRange("guitar")).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
    expect(fretRange("bass")[0]).toBe(9);
    expect(fretRange("bass").at(-1)).toBe(24);
  });
  it("marks the 12th fret in red on bass only", async () => {
    const { q, label } = mount();
    expect(q(".red-line-fret")).toBeNull();
    label("bass").click();
    await flush();
    expect(q(".string-row").querySelectorAll(".fret")).toHaveLength(16);
    expect(q(".string-row .red-line-fret").getAttribute("aria-label")).toMatch(
      /fret 12$/,
    );
    expect(q(".fret-header .red-line-fret").textContent).toBe("12");
  });
});

describe("preview", () => {
  it("windows high positions and shows fingers", () => {
    expect(previewStart(C.strings)).toBe(1);
    expect(
      previewStart([
        { state: "fretted", fret: 7, finger: 1 },
        { state: "fretted", fret: 12, finger: 4 },
      ]),
    ).toBe(9);
    const el = chordPreview("guitar", C.strings, "C");
    expect(el.getAttribute("aria-label")).toBe("C");
    expect(
      [...el.querySelectorAll(".chord-preview-dot")].map((d) => d.textContent),
    ).toEqual(["1", "2", "3"]);
  });
});

describe("ChordEditor", () => {
  it("builds and adds a chord, validating first", () => {
    const { editor, onChange, label, type, submit, q } = mount();
    submit();
    expect(q(".chord-form .field-error").textContent).toMatch(/name/);
    type("#chord-name", "C");
    submit();
    expect(q(".chord-form .field-error").textContent).toMatch(/three/);
    label("Mute E2").click();
    label("A2 fret 3").click();
    label("D3 fret 2").click();
    label("G3 fret 2").click();
    label("Open G3").click();
    label("B3 fret 1").click();
    label("Open E4").click();
    const finger = (tuning: string) =>
      q<HTMLSelectElement>(`[aria-label="Finger for ${tuning}"]`);
    finger("A2").value = "3";
    finger("A2").dispatchEvent(new Event("change"));
    finger("D3").value = "2";
    finger("D3").dispatchEvent(new Event("change"));
    expect(finger("G3").disabled).toBe(true);
    submit();
    expect(onChange).toHaveBeenLastCalledWith({ title: null, chords: [C] });
    expect(q(".chord-item strong").textContent).toBe("1 C");
    expect(q<HTMLInputElement>("#chord-name").value).toBe("");
    expect(editor.dirty).toBe(false);
  });

  it("numbers, reorders and duplicates chords", () => {
    const { editor, onChange, label } = mount();
    editor.load(seq(C, { ...C, baseName: "G" }));
    label("Duplicate 1 C").click();
    expect(onChange.mock.lastCall![0].chords.map((c) => c.baseName)).toEqual([
      "C",
      "C",
      "G",
    ]);
    expect(
      [...editor.root.querySelectorAll(".chord-item strong")].map(
        (s) => s.textContent,
      ),
    ).toEqual(["1 C", "2 C", "1 G"]);
    label("Move 1 G up").click();
    expect(onChange.mock.lastCall![0].chords.map((c) => c.baseName)).toEqual([
      "C",
      "G",
      "C",
    ]);
    expect(label("Move 1 C up").disabled).toBe(true);
  });

  it("asks before discarding a dirty draft", async () => {
    const confirm = vi.fn(async () => false);
    const { editor, label, type, q } = mount(confirm);
    editor.load(seq(C, { ...C, baseName: "G" }));
    label("Edit 1 C (guitar)").click();
    await flush();
    expect(q<HTMLInputElement>("#chord-name").value).toBe("C");
    expect(editor.dirty).toBe(false);
    type("#chord-name", "Cmaj");
    expect(editor.dirty).toBe(true);
    label("Edit 1 G (guitar)").click();
    await flush();
    expect(confirm).toHaveBeenCalledOnce();
    expect(q<HTMLInputElement>("#chord-name").value).toBe("Cmaj");
    confirm.mockResolvedValue(true);
    label("Edit 1 G (guitar)").click();
    await flush();
    expect(q<HTMLInputElement>("#chord-name").value).toBe("G");
    expect(editor.dirty).toBe(false);
  });

  it("keeps a dirty draft across reloads when asked", () => {
    const { editor, type, q } = mount();
    editor.load(seq(C));
    type("#chord-name", "D");
    editor.load(seq(C, C), false);
    expect(q<HTMLInputElement>("#chord-name").value).toBe("D");
    editor.load(seq(C));
    expect(q<HTMLInputElement>("#chord-name").value).toBe("");
  });

  it("edits the title and keeps it in the sequence", () => {
    const { editor, onChange, q } = mount();
    editor.load({ title: "Song", chords: [C] });
    const title = q<HTMLInputElement>("#chord-title");
    expect(title.value).toBe("Song");
    title.value = "  Other  ";
    title.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith({ title: "Other", chords: [C] });
  });

  it("shows validation errors of the file and refuses to save them", () => {
    const { editor, onChange, label, q } = mount();
    const bad = { ...C, baseName: "Bad", strings: C.strings.slice(0, 4) };
    editor.load(seq(C, bad));
    expect(q(".chord-errors").hidden).toBe(false);
    expect(q(".chord-errors").textContent).toBe(
      "1 Bad: guitar requires 6 strings.",
    );
    label("Move 1 C down").click();
    expect(onChange).not.toHaveBeenCalled();
    label("Edit 1 Bad (guitar)").click();
    expect(q<HTMLButtonElement>('[aria-label="Open E4"]')).not.toBeNull();
  });
});
