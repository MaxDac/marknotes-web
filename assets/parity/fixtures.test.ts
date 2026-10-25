// @vitest-environment jsdom
/**
 * Runs the marknotes-spec golden fixtures (the `spec/` git submodule) against the web implementation.
 * See spec/README.md "How apps consume this repository". Run with `npm run parity`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { executeSafetyFixture } from "../tests/sync-safety";
import {
  extensionFor,
  imageMarkdown,
  isAttachmentPath,
  referencedAttachments,
  scaledSize,
} from "../js/attachments";
import { mentionAt } from "../js/editor";
import {
  chordDisplayNames,
  isChordSequence,
  parseChordBody,
  serializeChordBody,
  validateChordSequence,
} from "../js/chords";
import {
  filterRefs,
  idsToAssign,
  joinFrontMatter,
  linkedId,
  noteId,
  noteLink,
  splitFrontMatter,
  withId,
} from "../js/notemeta";
import {
  SyncScheduler,
  buildManifest,
  conflictCopyName,
  merge3,
  mergeText,
  localDeletions,
  parseManifest,
  plan,
  reconcile,
  serializeManifest,
} from "@marknotes/sync";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Input = Record<string, any>;
interface Case {
  name: string;
  input: Input;
  expected: unknown;
  knownDivergence?: Partial<Record<"android" | "desktop" | "web", string>>;
}
interface Fixture {
  description: string;
  cases: Case[];
}
type Mapping = ((input: Input) => unknown) | { skip: string };

const ROOT = resolve(import.meta.dirname, "..", "..");
const FIXTURES = join(
  resolve(ROOT, process.env.MARKNOTES_SPEC_DIR ?? "spec"),
  "fixtures",
);

/** Fixture file (relative to fixtures/, without .json) → adapter calling the real web code. */
const mappings: Record<string, Mapping> = {
  "note-ids/validation": {
    skip: "the web app has no note id validator; ids are read as any token (see front-matter/read-id knownDivergence.web)",
  },
  "front-matter/read-id": ({ text }) => ({ id: noteId(text) ?? null }),
  "front-matter/with-id": ({ text, id }) => ({ text: withId(text, id) }),
  "front-matter/with-body": ({ frontMatter, body }) => ({
    text: joinFrontMatter(frontMatter, body),
  }),
  "front-matter/split": ({ text }) => {
    const { header, body } = splitFrontMatter(text);
    return { frontMatter: header, body };
  },
  "note-links/link-markdown": ({ title, id }) => ({
    markdown: noteLink({ title, id }),
  }),
  "note-links/parse-href": ({ href }) => ({ id: linkedId(href) ?? null }),
  "note-links/mention": ({ lineBeforeCursor }) => {
    const text = lineBeforeCursor as string;
    const mention = mentionAt(
      EditorState.create({
        doc: text,
        selection: EditorSelection.cursor(text.length),
      }),
    );
    return {
      mention: mention && { from: mention.from, query: mention.query },
    };
  },
  "note-links/filter": ({ query, notes }) => ({
    ids: filterRefs(
      (notes as { id: string; title: string; fullPath: string }[]).map((n) => ({
        id: n.id,
        title: n.title,
        label: n.fullPath,
        path: `${n.fullPath}.md`,
      })),
      query,
    ).map((r) => r.id),
  }),
  "attachments/extension-for-type": ({ mime }) => ({
    extension: extensionFor(mime) ?? null,
  }),
  "attachments/is-attachment-path": ({ path }) => ({
    isAttachment: isAttachmentPath(path),
  }),
  "attachments/image-markdown": ({ fileName, path }) => ({
    markdown: imageMarkdown(fileName, path),
  }),
  "attachments/scaled-size": ({ width, height }) => {
    const size = scaledSize(width, height);
    return size ? { ...size, scaled: true } : { width, height, scaled: false };
  },
  "attachments/refs": ({ text }) => ({
    refs: [...referencedAttachments([text])].sort(),
  }),
  // Sync, manifest and merge come from the shared core (@marknotes/sync); the web app only runs its actions.
  "sync/plan": (input) => plan(input as Parameters<typeof plan>[0]),
  "sync/reconcile": (input) =>
    reconcile(input as Parameters<typeof reconcile>[0]),
  "sync/executor-safety": (input) =>
    executeSafetyFixture(input as Parameters<typeof executeSafetyFixture>[0]),
  "sync/local-deletions": ({ local, records }) => ({
    paths: localDeletions(local, records),
  }),
  "sync/multi-drive": ({ driveIds, maxPasses, reports }) => {
    const scheduler = new SyncScheduler(driveIds, maxPasses);
    const order: string[] = [];
    try {
      for (let id = scheduler.next(); id !== undefined; id = scheduler.next()) {
        const r = reports[order.length];
        scheduler.report(id, r.localChanges, r.failed);
        order.push(id);
      }
    } finally {
      scheduler.free();
    }
    return { order };
  },
  "manifest/parse": ({ json }) => ({ manifest: parseManifest(json) }),
  "manifest/serialize": (input) => ({
    json: serializeManifest(input as Parameters<typeof serializeManifest>[0]),
  }),
  "manifest/build": ({ records, deviceId, nowMillis, previous }) => ({
    json: buildManifest(records, deviceId, nowMillis, previous) ?? null,
  }),
  "duplicate-ids/resolve": ({ notes }) => ({
    reassigned: [
      ...idsToAssign(
        (notes as { path: string; id: string }[]).map((n) => ({
          path: n.path,
          text: withId("", n.id),
        })),
      ),
    ].sort(),
  }),
  "merge/merge3": ({ base, local, remote, choices }) => {
    const result = merge3(base, local, remote);
    const text = choices ? mergeText(result.chunks, choices) : result.text;
    return { text, conflicts: result.conflicts };
  },
  "merge/conflict-copy-name": ({ path, existingPaths }) => ({
    path: conflictCopyName(path, existingPaths ?? []),
  }),
  "chords/detect": ({ text }) => ({ chords: isChordSequence(text) }),
  "chords/parse": ({ body }) => parseChordBody(body),
  "chords/serialize": ({ sequence, lineEnding }) => ({
    body: serializeChordBody(sequence, lineEnding),
  }),
  "chords/validate": ({ sequence }) => ({
    errors: validateChordSequence(sequence),
  }),
  "chords/display-names": ({ chords }) => ({
    displayNames: chordDisplayNames(chords),
  }),
};

/**
 * Cases failing without a spec `knownDivergence.web` entry yet, as `file::case` → reason.
 * TODO: remove each entry once marknotes-spec records the divergence (or the web app is fixed).
 */
const pending: Record<string, string> = {};

/**
 * Cases marknotes-spec still records as `knownDivergence.web` that the web app now satisfies, as `file::case`. They
 * are asserted equal. TODO: remove each entry once marknotes-spec drops the divergence.
 */
const resolved = new Set(
  [
    "a failed child download after ancestor replacement cannot restore stale deletion authority on restart",
    "an explicitly unsupported removal preserves the folder with one notice and no recursive request",
    "a pending manual-removal notice survives restart without folder resurrection or repeat actions",
    "an acknowledged notice is not issued again after restart",
    "a new remote child revives a preserved folder and is downloaded",
    "a changed recorded remote child wins over preserved folder deletion",
    "an ignored descendant protects a preserved folder without being downloaded",
    "a new empty remote subfolder revives its preserved parent",
    "local recreation permits a new notice for a later deletion of the same identity",
    "local recreation with a missing remote counterpart creates remote instead of deleting local",
    "remote disappearance retires the retained folder record and active notice",
    "a replacement remote folder and descendant are not suppressed by an old deletion identity",
    "two drives deduplicate independently and local recreation retires both histories before planning",
    "new safe deletion support removes the retained folder and retires its notice",
    "a failed listing cannot retire deferred state or imply remote disappearance",
    "restart before preservation commits retries without losing the deletion baseline",
    "restart after preservation commits keeps the pending notice without a duplicate",
    "a failed preservation save is an explicit error and the next restart safely retries",
    "a failed acknowledgement save leaves the same notice pending across restart",
    "restart after recreation preflight cannot delete the restored folder",
    "an unsupported provider does not hide a conditional child deletion failure",
    "unchanged preserved subfolders do not resurrect their preserved parent",
    "local recreation after planning prevents a stale preservation action",
  ]
    .map((name) => `sync/executor-safety::${name}`)
    .concat(
      [
        "a local parent case rename migrates a remote-only preserved descendant",
        "a drive parent case rename migrates a remote-only preserved descendant",
        "unsupported empty folder deletion preserves history instead of requesting removal",
        "an unchanged preserved remote folder produces no repeat action",
        "a preserved folder replacement is new remote content",
        "both present folders clear a preserved marker by recording",
      ].map((name) => `sync/plan::${name}`),
    ),
);

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return fixtureFiles(path);
    return entry.name.endsWith(".json") ? [path] : [];
  });
}

function load(file: string): Fixture {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${file}.json`), "utf8"),
  ) as Fixture;
}

if (!existsSync(FIXTURES))
  throw new Error(
    `marknotes-spec fixtures not found at ${FIXTURES}; run \`git submodule update --init spec\`.`,
  );

const files = fixtureFiles(FIXTURES)
  .map((path) => relative(FIXTURES, path).replace(/\\/g, "/").slice(0, -5))
  .sort();

describe("marknotes-spec fixtures", () => {
  it("maps every fixture file, and every mapping has a fixture file", () => {
    expect(files.filter((f) => !(f in mappings))).toEqual([]);
    expect(Object.keys(mappings).filter((f) => !files.includes(f))).toEqual([]);
  });

  it("lists only existing cases as pending", () => {
    const cases = new Set(
      files.flatMap((file) =>
        load(file).cases.map((c) => `${file}::${c.name}`),
      ),
    );
    expect(Object.keys(pending).filter((key) => !cases.has(key))).toEqual([]);
  });

  it("lists only cases with a web divergence as resolved", () => {
    const divergent = new Set(
      files.flatMap((file) =>
        load(file)
          .cases.filter((c) => c.knownDivergence?.web)
          .map((c) => `${file}::${c.name}`),
      ),
    );
    expect([...resolved].filter((key) => !divergent.has(key))).toEqual([]);
  });

  for (const file of files) {
    const mapping = mappings[file];
    if (!mapping) continue;
    describe(file, () => {
      if (typeof mapping !== "function") {
        it.skip(`not implemented in web: ${mapping.skip}`, () => {});
        return;
      }
      for (const c of load(file).cases) {
        const divergence = c.knownDivergence?.web;
        const todo = pending[`${file}::${c.name}`];
        if (todo) it.skip(`${c.name} — TODO: ${todo}`, () => {});
        else if (divergence && !resolved.has(`${file}::${c.name}`))
          it(`${c.name} (known divergence: ${divergence})`, async () => {
            expect(await mapping(c.input)).not.toEqual(c.expected);
          });
        else
          it(c.name, async () => {
            expect(await mapping(c.input)).toEqual(c.expected);
          });
      }
    });
  }
});
