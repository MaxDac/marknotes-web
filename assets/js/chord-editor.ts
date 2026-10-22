/** Graphical chord-sequence editor, ported from MaxDac/ChordBuilder's builder, fretboard and preview. */
import {
  TUNINGS,
  chordDisplayNames as displayNames,
  emptyStrings,
  fretsText,
  normalizeChord,
  normalizeTitle,
  validateChord,
  validateChordSequence,
  type Chord,
  type ChordSequence,
  type ChordValidationError,
  type Instrument,
  type StringSelection,
} from "./chords";
import {
  button,
  confirmDialog,
  element,
  segmented,
  showError,
} from "./components";

const MARKERS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);
export const RED_LINE_FRET = 12;
const PREVIEW_WINDOW = 4;

/** Guitar shows frets 1-24; bass shows 9-24 (as in ChordBuilder). */
export function fretRange(instrument: Instrument): number[] {
  const first = instrument === "bass" ? 9 : 1;
  return Array.from({ length: 24 - first + 1 }, (_, i) => i + first);
}

/** First fret shown by the 4-fret preview window. */
export function previewStart(strings: readonly StringSelection[]): number {
  const frets = strings.flatMap((s) => (s.state === "fretted" ? [s.fret] : []));
  if (!frets.length) return 1;
  const min = Math.min(...frets),
    max = Math.max(...frets);
  if (max - min < PREVIEW_WINDOW) return min;
  return Math.max(1, max - PREVIEW_WINDOW + 1);
}

/** Small diagram of a chord shape (strings as rows, 4 frets as columns). */
export function chordPreview(
  instrument: Instrument,
  strings: readonly StringSelection[],
  label: string,
): HTMLElement {
  const root = element("div", undefined, "chord-preview");
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", label);
  const start = previewStart(strings);
  if (start > 1)
    root.append(element("span", `${start}fr`, "chord-preview-position"));
  const grid = element("div", undefined, "chord-preview-grid");
  // Highest string on top, like a tab staff.
  [...TUNINGS[instrument].keys()].reverse().forEach((index) => {
    const s = strings[index];
    if (!s) return;
    const row = element("div", undefined, "chord-preview-row");
    row.append(
      element(
        "span",
        s.state === "muted" ? "×" : s.state === "open" ? "O" : "",
        "chord-preview-indicator",
      ),
    );
    const frets = element("div", undefined, "chord-preview-frets");
    for (let fret = start; fret < start + PREVIEW_WINDOW; fret++) {
      const cell = element("span", undefined, "chord-preview-cell");
      if (s.state === "fretted" && s.fret === fret)
        cell.append(element("span", String(s.finger), "chord-preview-dot"));
      frets.append(cell);
    }
    row.append(frets);
    grid.append(row);
  });
  root.append(grid);
  return root;
}

interface Draft {
  index?: number;
  name: string;
  instrument: Instrument;
  strings: StringSelection[];
  tagText: string;
  note: string;
}

const newDraft = (instrument: Instrument): Draft => ({
  name: "",
  instrument,
  strings: emptyStrings(instrument),
  tagText: "",
  note: "",
});
const toDraft = (chord: Chord, index: number): Draft => ({
  index,
  name: chord.baseName,
  instrument: chord.instrument,
  // A file may hold the wrong number of strings; the builder always shows one row per tuned string.
  strings: TUNINGS[chord.instrument].map((_, i): StringSelection => ({
    ...(chord.strings[i] ?? { state: "muted" }),
  })),
  tagText: chord.tags.join(", "),
  note: chord.note,
});
const fingerprint = (d: Draft) => JSON.stringify({ ...d, index: undefined });

export interface ChordEditorOptions {
  /** Called with the new, valid sequence whenever the user changes it. */
  onChange: (sequence: ChordSequence) => void;
  /** Asks the user to confirm discarding an unsaved draft. */
  confirm?: (text: string) => Promise<boolean>;
  status?: (text: string) => void;
}

export class ChordEditor {
  readonly root = element("div", undefined, "chord-editor");
  private chords: Chord[] = [];
  private title: string | null = null;
  private titleInput = element("input", undefined, "input chord-title");
  private sequenceProblem = element(
    "ul",
    undefined,
    "field-error chord-errors",
  );
  private draft: Draft = newDraft("guitar");
  private baseline = fingerprint(this.draft);
  private list = element("ol", undefined, "chord-list");
  private form = element("form", undefined, "chord-form");
  private problem = element("p", undefined, "field-error");
  private confirm: (text: string) => Promise<boolean>;

  constructor(private options: ChordEditorOptions) {
    this.confirm =
      options.confirm ??
      ((text) =>
        confirmDialog({
          title: "Discard unsaved chord?",
          text,
          confirm: "Discard",
          danger: true,
        }));
    this.problem.setAttribute("role", "alert");
    this.problem.hidden = true;
    const listPane = element("section", undefined, "chord-sequence");
    listPane.setAttribute("aria-label", "Chord sequence");
    const head = element("div", undefined, "chord-sequence-head");
    head.append(
      element("h2", "Sequence", "section-title"),
      button("New chord", () => void this.startNew(), {
        icon: "plus",
        variant: "outline",
        id: "new-chord",
      }),
    );
    this.titleInput.id = "chord-title";
    this.titleInput.autocomplete = "off";
    this.titleInput.placeholder = "Song or progression";
    this.titleInput.addEventListener("change", () => {
      const title = normalizeTitle(this.titleInput.value);
      if (title !== this.title)
        this.change(this.chords, title, "Updated title");
    });
    const titleField = element("div", undefined, "field");
    const titleLabel = element("label", "Title");
    titleLabel.htmlFor = "chord-title";
    titleField.append(titleLabel, this.titleInput);
    this.sequenceProblem.setAttribute("role", "alert");
    this.sequenceProblem.hidden = true;
    listPane.append(head, titleField, this.sequenceProblem, this.list);
    this.form.setAttribute("aria-label", "Chord builder");
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.saveDraft();
    });
    this.root.append(listPane, this.form);
    this.render();
  }

  get dirty(): boolean {
    return fingerprint(this.draft) !== this.baseline;
  }

  /** Replaces the sequence. A dirty draft is kept unless `reset`; it becomes a new chord if its target is gone. */
  load(sequence: ChordSequence, reset = true): void {
    const { chords, title } = sequence;
    this.chords = chords;
    this.title = title;
    this.titleInput.value = title ?? "";
    this.showSequenceErrors(validateChordSequence(sequence), chords);
    if (reset || !this.dirty) this.reset(this.draft.instrument);
    else if (
      this.draft.index !== undefined &&
      this.draft.index >= chords.length
    )
      this.draft.index = undefined;
    this.render();
  }

  /** Discards the draft without asking. */
  discard(): void {
    this.reset(this.draft.instrument);
    this.render();
  }

  private reset(instrument: Instrument): void {
    this.draft = newDraft(instrument);
    this.baseline = fingerprint(this.draft);
    showError(this.problem, "");
  }

  private async leaveDraft(): Promise<boolean> {
    return (
      !this.dirty ||
      this.confirm("The chord you are editing has unsaved changes.")
    );
  }

  private async startNew(): Promise<void> {
    if (!(await this.leaveDraft())) return;
    this.reset(this.draft.instrument);
    this.render();
    this.form.querySelector<HTMLInputElement>("#chord-name")?.focus();
  }

  private async edit(index: number): Promise<void> {
    if (this.draft.index === index && !this.dirty) return;
    if (!(await this.leaveDraft())) return;
    this.draft = toDraft(this.chords[index]!, index);
    this.baseline = fingerprint(this.draft);
    showError(this.problem, "");
    this.render();
    this.options.status?.(`Editing ${displayNames(this.chords)[index]}`);
  }

  private async switchInstrument(instrument: Instrument): Promise<void> {
    if (instrument === this.draft.instrument) return;
    if (
      this.draft.strings.some((s) => s.state !== "muted") &&
      !(await this.confirm("Switching instrument clears the selected strings."))
    ) {
      this.renderForm();
      return;
    }
    this.draft.instrument = instrument;
    this.draft.strings = emptyStrings(instrument);
    this.renderForm();
  }

  /** Applies a change only when the whole sequence is valid; returns whether it was applied. */
  private change(
    chords: Chord[],
    title: string | null,
    status: string,
  ): boolean {
    const sequence = { title, chords };
    const errors = validateChordSequence(sequence);
    this.showSequenceErrors(errors, chords);
    if (errors.length) {
      this.titleInput.value = this.title ?? "";
      return false;
    }
    this.chords = chords;
    this.title = title;
    this.options.onChange(sequence);
    this.options.status?.(status);
    this.render();
    return true;
  }

  private showSequenceErrors(
    errors: ChordValidationError[],
    chords: Chord[],
  ): void {
    const names = displayNames(chords);
    this.sequenceProblem.replaceChildren(
      ...errors.map((e) =>
        element(
          "li",
          e.chord === null
            ? e.message
            : `${names[e.chord] ?? `Chord ${e.chord + 1}`}: ${e.message}`,
        ),
      ),
    );
    this.sequenceProblem.hidden = !errors.length;
  }

  private saveDraft(): void {
    const chord = normalizeChord({
      baseName: this.draft.name,
      instrument: this.draft.instrument,
      strings: this.draft.strings,
      tags: this.draft.tagText.split(","),
      note: this.draft.note,
    });
    const problems = validateChord(chord);
    if (problems.length) {
      showError(this.problem, problems.join(" "));
      return;
    }
    const chords = [...this.chords];
    const index = this.draft.index ?? chords.length;
    const added = this.draft.index === undefined;
    chords[index] = chord;
    const status = `${added ? "Added" : "Updated"} ${displayNames(chords)[index]}`;
    if (!this.change(chords, this.title, status)) return;
    if (added) this.reset(this.draft.instrument);
    else {
      this.draft = toDraft(chord, index);
      this.baseline = fingerprint(this.draft);
      showError(this.problem, "");
    }
    this.render();
  }

  private move(index: number, by: number): void {
    const to = index + by;
    if (to < 0 || to >= this.chords.length) return;
    const chords = [...this.chords];
    [chords[index], chords[to]] = [chords[to]!, chords[index]!];
    const draft = this.draft.index;
    if (!this.change(chords, this.title, "Moved chord")) return;
    if (draft === index) this.draft.index = to;
    else if (draft === to) this.draft.index = index;
    this.render();
  }

  private duplicate(index: number): void {
    const chords = [...this.chords];
    chords.splice(index + 1, 0, structuredClone(chords[index]!));
    const name = displayNames(this.chords)[index]!;
    const draft = this.draft.index;
    if (!this.change(chords, this.title, `Duplicated ${name}`)) return;
    if (draft !== undefined && draft > index) this.draft.index = draft + 1;
    this.render();
  }

  private async remove(index: number): Promise<void> {
    const name = displayNames(this.chords)[index]!;
    const ok = await confirmDialog({
      title: `Delete ${name}?`,
      text: "The chord will be removed from this sequence.",
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return;
    const chords = this.chords.filter((_, i) => i !== index);
    const draft = this.draft.index;
    if (!this.change(chords, this.title, `Deleted ${name}`)) return;
    if (draft === index) this.reset(this.draft.instrument);
    else if (draft !== undefined && draft > index) this.draft.index = draft - 1;
    this.render();
  }

  private render(): void {
    this.renderList();
    this.renderForm();
  }

  private renderList(): void {
    this.list.replaceChildren();
    const names = displayNames(this.chords);
    this.chords.forEach((chord, index) => {
      const item = element("li", undefined, "chord-item");
      if (this.draft.index === index) item.setAttribute("aria-current", "true");
      const open = element("button", undefined, "chord-open");
      open.type = "button";
      open.setAttribute(
        "aria-label",
        `Edit ${names[index]} (${chord.instrument})`,
      );
      open.addEventListener("click", () => void this.edit(index));
      const text = element("span", undefined, "chord-item-text");
      text.append(
        element("strong", names[index]),
        element("small", chord.instrument, "chord-chip"),
      );
      if (chord.tags.length)
        text.append(element("small", chord.tags.join(", "), "chord-tags"));
      open.append(
        chordPreview(
          chord.instrument,
          chord.strings,
          `${names[index]}: ${fretsText(chord.strings)}`,
        ),
        text,
      );
      const actions = element("div", undefined, "chord-item-actions");
      const up = button(`Move ${names[index]} up`, () => this.move(index, -1), {
        icon: "up",
        iconOnly: true,
      });
      const down = button(
        `Move ${names[index]} down`,
        () => this.move(index, 1),
        { icon: "down", iconOnly: true },
      );
      up.disabled = index === 0;
      down.disabled = index === this.chords.length - 1;
      actions.append(
        up,
        down,
        button(`Duplicate ${names[index]}`, () => this.duplicate(index), {
          icon: "copy",
          iconOnly: true,
        }),
        button(`Delete ${names[index]}`, () => void this.remove(index), {
          icon: "trash",
          iconOnly: true,
        }),
      );
      item.append(open, actions);
      this.list.append(item);
    });
    if (!this.chords.length)
      this.list.append(
        element(
          "li",
          "No chords yet. Build one on the fretboard and save it.",
          "hint chord-empty",
        ),
      );
  }

  private renderForm(): void {
    const d = this.draft;
    const title =
      d.index === undefined
        ? "New chord"
        : `Edit ${displayNames(this.chords)[d.index] ?? d.name}`;
    const name = element("input", undefined, "input");
    name.id = "chord-name";
    name.value = d.name;
    name.maxLength = 80;
    name.autocomplete = "off";
    name.placeholder = "e.g. C, Am7, G/B";
    name.addEventListener("input", () => (d.name = name.value));
    const tags = element("input", undefined, "input");
    tags.id = "chord-tags";
    tags.value = d.tagText;
    tags.autocomplete = "off";
    tags.placeholder = "open, major, verse";
    tags.addEventListener("input", () => (d.tagText = tags.value));
    const note = element("textarea", undefined, "input chord-note");
    note.id = "chord-note";
    note.value = d.note;
    note.maxLength = 1000;
    note.rows = 3;
    note.addEventListener("input", () => (d.note = note.value));
    const field = (label: string, control: HTMLElement, id?: string) => {
      const wrap = element("div", undefined, "field");
      const l = element("label", label);
      if (id) l.htmlFor = id;
      wrap.append(l, control);
      return wrap;
    };
    const instrument = segmented(
      "Instrument",
      [
        { value: "guitar", label: "Guitar" },
        { value: "bass", label: "Bass" },
      ],
      d.instrument,
      (value) => void this.switchInstrument(value as Instrument),
    );
    const actions = element("div", undefined, "chord-form-actions");
    const save = button(
      d.index === undefined ? "Add chord" : "Save chord",
      undefined,
      {
        variant: "solid",
        id: "save-chord",
      },
    );
    save.type = "submit";
    actions.append(
      button("Reset", () => void this.resetDraft(), { variant: "outline" }),
      save,
    );
    const row = element("div", undefined, "chord-form-row");
    row.append(
      field("Chord name", name, "chord-name"),
      field("Instrument", instrument),
    );
    const scrolled =
      this.form.querySelector<HTMLElement>(".fretboard-scroll")?.scrollLeft ??
      0;
    const board = this.fretboard();
    this.form.replaceChildren(
      element("h2", title, "section-title"),
      row,
      board,
      field("Tags (comma separated)", tags, "chord-tags"),
      field("Note", note, "chord-note"),
      this.problem,
      actions,
    );
    board.scrollLeft = scrolled;
  }

  private async resetDraft(): Promise<void> {
    if (!(await this.leaveDraft())) return;
    const index = this.draft.index;
    if (index !== undefined) this.draft = toDraft(this.chords[index]!, index);
    else this.draft = newDraft(this.draft.instrument);
    this.baseline = fingerprint(this.draft);
    showError(this.problem, "");
    this.renderForm();
  }

  private fretboard(): HTMLElement {
    const { instrument, strings } = this.draft;
    const frets = fretRange(instrument);
    const scroll = element("div", undefined, "fretboard-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "group");
    scroll.setAttribute(
      "aria-label",
      `Fretboard, ${frets.length} frets, scrollable`,
    );
    const board = element("div", undefined, `fretboard ${instrument}`);
    board.style.setProperty("--frets", String(frets.length));
    const header = element("div", undefined, "fret-header");
    header.setAttribute("aria-hidden", "true");
    header.append(
      element("span", "String"),
      element("span", "Mute"),
      element("span", "Open"),
    );
    for (const fret of frets) {
      const cell = element("span", String(fret));
      if (MARKERS.has(fret)) cell.classList.add("marker");
      if (instrument === "bass" && fret === RED_LINE_FRET)
        cell.classList.add("red-line-fret");
      header.append(cell);
    }
    header.append(element("span", "Finger"));
    board.append(header);
    const update = (index: number, value: StringSelection) => {
      strings[index] = value;
      this.renderForm();
      this.form
        .querySelector<HTMLElement>(
          `[data-string="${index}"] [aria-pressed=true]`,
        )
        ?.focus();
    };
    // Highest string on top, matching the preview.
    [...TUNINGS[instrument].entries()].reverse().forEach(([index, tuning]) => {
      const s = strings[index]!;
      const row = element("fieldset", undefined, "string-row");
      row.dataset.string = String(index);
      row.append(
        element("legend", `${tuning} string`, "sr-only"),
        element("strong", tuning, "tuning-label"),
      );
      const choice = (
        text: string,
        label: string,
        pressed: boolean,
        className: string,
        value: StringSelection,
      ) => {
        const b = element(
          "button",
          text,
          `${className}${pressed ? " selected" : ""}`,
        );
        b.type = "button";
        b.setAttribute("aria-pressed", String(pressed));
        b.setAttribute("aria-label", label);
        b.addEventListener("click", () => update(index, value));
        return b;
      };
      row.append(
        choice("×", `Mute ${tuning}`, s.state === "muted", "mute", {
          state: "muted",
        }),
        choice("O", `Open ${tuning}`, s.state === "open", "open", {
          state: "open",
        }),
      );
      for (const fret of frets) {
        const on = s.state === "fretted" && s.fret === fret;
        const b = choice(
          on && s.state === "fretted" ? String(s.finger) : "",
          `${tuning} fret ${fret}`,
          on,
          "fret",
          {
            state: "fretted",
            fret,
            finger: s.state === "fretted" ? s.finger : 1,
          },
        );
        if (MARKERS.has(fret)) b.classList.add("marker-fret");
        if (instrument === "bass" && fret === RED_LINE_FRET)
          b.classList.add("red-line-fret");
        row.append(b);
      }
      const finger = element("select", undefined, "input finger");
      finger.setAttribute("aria-label", `Finger for ${tuning}`);
      finger.disabled = s.state !== "fretted";
      for (const n of [1, 2, 3, 4]) {
        const option = element("option", String(n));
        option.value = String(n);
        finger.append(option);
      }
      finger.value = String(s.state === "fretted" ? s.finger : 1);
      finger.addEventListener("change", () => {
        if (s.state === "fretted")
          update(index, { ...s, finger: Number(finger.value) });
      });
      row.append(finger);
      board.append(row);
    });
    scroll.append(board);
    return scroll;
  }
}
