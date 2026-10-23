/**
 * Merge-back of conflicted copies (marknotes-spec, "Conflicts"). When a note changed on this device and on a drive
 * and the edits overlapped, sync kept the newest version at the note's path and saved the other one as a
 * `(conflicted copy)` note. Here the user can three-way merge the copy back into the note, discard the copy, or keep
 * both files. A conflict stays listed while both the note and its copy exist.
 */
import {
  type ConflictChoice,
  type MergeResult,
  merge3,
  mergeText,
  readId,
  withId,
} from "@marknotes/sync";
import { type Store } from "./storage";
import { type SyncConflict } from "./sync";
import {
  button,
  element,
  segmented,
  showError,
  type Choice,
} from "./components";

export type { SyncConflict };
export const CONFLICTS_KEY = "sync-conflicts";

const same = (a: SyncConflict, b: SyncConflict) =>
  a.path === b.path && a.copyPath === b.copyPath;

async function exists(store: Store, path: string): Promise<boolean> {
  const note = await store.note(path);
  return !!note && !note.folder;
}

/** The conflicts whose note and copy both still exist, oldest first; the others are dropped from the list. */
export async function pendingConflicts(store: Store): Promise<SyncConflict[]> {
  const all = (await store.value<SyncConflict[]>(CONFLICTS_KEY)) ?? [];
  const pending: SyncConflict[] = [];
  for (const c of all)
    if ((await exists(store, c.path)) && (await exists(store, c.copyPath)))
      pending.push(c);
  if (pending.length !== all.length) await store.put(CONFLICTS_KEY, pending);
  return pending;
}

/** Adds the conflicts found by a sync to the list (once each: every drive reports the same copy at most once). */
export async function addConflicts(
  store: Store,
  conflicts: SyncConflict[],
): Promise<void> {
  if (!conflicts.length) return;
  const all = (await store.value<SyncConflict[]>(CONFLICTS_KEY)) ?? [];
  for (const c of conflicts) if (!all.some((o) => same(o, c))) all.push(c);
  await store.put(CONFLICTS_KEY, all);
}

/** "Keep both files": the note and its copy stay as they are, the conflict leaves the list. */
export async function keepBoth(
  store: Store,
  conflict: SyncConflict,
): Promise<void> {
  const all = (await store.value<SyncConflict[]>(CONFLICTS_KEY)) ?? [];
  await store.put(
    CONFLICTS_KEY,
    all.filter((c) => !same(c, conflict)),
  );
}

/** "Discard copy": deletes the conflicted copy; the next sync deletes it from the drives. */
export async function discardCopy(
  store: Store,
  conflict: SyncConflict,
): Promise<void> {
  await store.delete(conflict.copyPath);
  await keepBoth(store, conflict);
}

/**
 * Three-way merges the note ("local", the kept version) and its copy ("remote") against the base. The copy got a new
 * id when it was saved, so it takes the note's id first: the merged note keeps its identity.
 */
export function mergeBack(
  baseText: string | null,
  note: string,
  copy: string,
): MergeResult {
  const id = readId(note);
  const aligned = id && readId(copy) ? withId(copy, id) : copy;
  return merge3(baseText, note, aligned);
}

/** Reads the note and its copy and merges them; undefined when either no longer exists. */
export async function loadMerge(
  store: Store,
  conflict: SyncConflict,
): Promise<MergeResult | undefined> {
  const note = await store.note(conflict.path),
    copy = await store.note(conflict.copyPath);
  if (!note || note.folder || !copy || copy.folder) return undefined;
  return mergeBack(conflict.baseText, note.text, copy.text);
}

/** "Merge copy back": saves `text` as the note and deletes the copy. */
export async function applyMerge(
  store: Store,
  conflict: SyncConflict,
  text: string,
): Promise<void> {
  await store.write(conflict.path, text);
  await discardCopy(store, conflict);
}

/** Explains which version was kept; `drive` names the drive the conflict was found on. */
export function describeConflict(
  conflict: SyncConflict,
  drive: string,
): string {
  const kept = conflict.winner === "local" ? "this device" : drive,
    saved = conflict.winner === "local" ? drive : "this device";
  return `Changed on this device and on ${drive}. The newest version (from ${kept}) was kept; the version from ${saved} was saved as ${conflict.copyPath}.`;
}

const CHOICES: Choice[] = [
  { value: "local", label: "Kept" },
  { value: "remote", label: "Copy" },
  { value: "both", label: "Both" },
  { value: "neither", label: "Neither" },
];

export interface MergeViewActions {
  /** Saves the merged text as the note and deletes the copy. */
  merge(text: string): Promise<void>;
  discard(): Promise<void>;
  keepBoth(): Promise<void>;
}

const lines = (text: string[], className: string, label?: string) => {
  const block = element("div", undefined, `merge-block ${className}`);
  if (label) block.append(element("h4", label, "merge-label"));
  block.append(element("pre", text.join(""), "merge-text"));
  return block;
};

/**
 * The merge-back view of one conflict: the unchanged parts, each conflicting change with the kept version and the
 * conflicted copy side by side and a Kept / Copy / Both / Neither choice, and the actions.
 */
export function mergeView(
  conflict: SyncConflict,
  drive: string,
  result: MergeResult,
  actions: MergeViewActions,
): HTMLElement {
  const root = element("section", undefined, "merge-view");
  root.setAttribute("aria-label", `Conflict in ${conflict.path}`);
  const error = element("p", undefined, "field-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const choices: Record<number, ConflictChoice> = {};
  const run = (work: () => Promise<void>) => async () => {
    for (const b of root.querySelectorAll("button")) b.disabled = true;
    try {
      await work();
    } catch (e) {
      showError(error, e instanceof Error ? e.message : String(e));
      for (const b of root.querySelectorAll("button")) b.disabled = false;
      update();
    }
  };
  const chunks = element("div", undefined, "merge-chunks");
  let index = 0;
  for (const chunk of result.chunks) {
    if (chunk.kind === "resolved") {
      if (chunk.lines.length)
        chunks.append(lines(chunk.lines, "merge-resolved"));
      continue;
    }
    const n = index++;
    const hunk = element("div", undefined, "merge-conflict");
    const choice = segmented(`Change ${n + 1}`, CHOICES, "", (value) => {
      choices[n] = value as ConflictChoice;
      update();
    });
    // Nothing is chosen yet: keep the group reachable with Tab.
    choice.querySelector<HTMLElement>("[role=radio]")!.tabIndex = 0;
    hunk.append(
      element("h3", `Change ${n + 1}`, "merge-title"),
      lines(chunk.local, "merge-local", "Kept version"),
      lines(chunk.remote, "merge-remote", "Conflicted copy"),
      choice,
    );
    chunks.append(hunk);
  }
  const intro = element("p", describeConflict(conflict, drive));
  const summary = element(
    "p",
    result.hasConflicts
      ? `Choose what to keep for each of the ${result.conflicts} conflicting change(s), or edit the merged text.`
      : "The two versions merge without conflicts.",
    "hint",
  );
  const mergeButton = button(
    "Merge copy back",
    run(() => actions.merge(mergeText(result.chunks, choices))),
    { variant: "solid", className: "merge-apply" },
  );
  const footer = element("div", undefined, "merge-actions");
  footer.append(
    button(
      "Keep both files",
      run(() => actions.keepBoth()),
      { variant: "outline" },
    ),
    button(
      "Discard copy",
      run(() => actions.discard()),
      { variant: "danger" },
    ),
    button("Edit merged", () => edit(), { variant: "outline" }),
    mergeButton,
  );
  const update = () => {
    mergeButton.disabled = Object.keys(choices).length < result.conflicts;
  };
  const edit = () => {
    const field = element("div", undefined, "field merge-edit");
    const label = element("label", "Merged text"),
      area = element("textarea", undefined, "input merge-editor");
    area.id = `merge-edit-${conflict.copyPath}`;
    label.htmlFor = area.id;
    area.value = mergeText(result.chunks, choices);
    area.spellcheck = false;
    const buttons = element("div", undefined, "merge-actions");
    buttons.append(
      button(
        "Cancel",
        () => {
          field.replaceWith(chunks);
          buttons.replaceWith(footer);
        },
        { variant: "outline" },
      ),
      button(
        "Save",
        run(() => actions.merge(area.value)),
        { variant: "solid" },
      ),
    );
    field.append(label, area);
    chunks.replaceWith(field);
    footer.replaceWith(buttons);
    area.focus();
  };
  root.append(intro, summary, chunks, error, footer);
  update();
  return root;
}
