// @vitest-environment jsdom
/**
 * Runs the marknotes-spec golden fixtures (the `spec/` git submodule) against the web implementation.
 * See spec/README.md "How apps consume this repository". Run with `npm run parity`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
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
  linkedId,
  noteId,
  noteLink,
  splitFrontMatter,
  withId,
} from "../js/notemeta";
import { copyName, parseManifest, serializeManifest } from "../js/sync";

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
  "manifest/parse": ({ json }) => {
    let manifest;
    try {
      manifest = parseManifest(json);
    } catch {
      return { manifest: null };
    }
    if (!manifest) return { manifest: null };
    const files = Object.fromEntries(
      Object.entries(manifest.files).map(([path, f]) => [
        path,
        { sha256: f.sha256, version: f.version, syncedAt: f.syncedAt },
      ]),
    );
    return {
      manifest: {
        deviceId: manifest.deviceId,
        updatedAt: manifest.updatedAt,
        files,
      },
    };
  },
  "manifest/serialize": (input) => ({
    json: serializeManifest(input as Parameters<typeof serializeManifest>[0]),
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
  "merge/merge3": {
    skip: "the web app has no three-way merge; sync is newest-wins with a conflicted copy",
  },
  "merge/conflict-copy-name": ({ path }) => ({ path: copyName(path, 1) }),
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
        else if (divergence)
          it(`${c.name} (known divergence: ${divergence})`, () => {
            expect(mapping(c.input)).not.toEqual(c.expected);
          });
        else
          it(c.name, () => {
            expect(mapping(c.input)).toEqual(c.expected);
          });
      }
    });
  }
});
