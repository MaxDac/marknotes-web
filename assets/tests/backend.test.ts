// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDB } from "idb";
import {
  DB_VERSION,
  IdbBackend,
  MemoryBackend,
  dump,
  openDatabase,
  type Backend,
  type Change,
} from "../js/backend";
import type { Note } from "../js/storage";

const note = (path: string, text = ""): Note => ({
  path,
  folder: false,
  text,
  revision: "r1",
});

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function idbBackend(): Promise<IdbBackend> {
  const backend = new IdbBackend(await openDatabase(crypto.randomUUID()));
  closers.push(() => backend.close());
  return backend;
}

describe("openDatabase", () => {
  it("creates every store of the current schema", async () => {
    const db = await openDatabase(crypto.randomUUID());
    closers.push(() => db.close());
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      "attachments",
      "meta",
      "notes",
      "sealed",
      "values",
    ]);
  });

  it("upgrades a version 1 database without losing notes or settings", async () => {
    const name = crypto.randomUUID();
    const old = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("notes", { keyPath: "path" });
        db.createObjectStore("values");
      },
    });
    await old.put("notes", note("Old.md", "kept"));
    await old.put("values", "dark", "theme");
    old.close();

    const db = await openDatabase(name);
    closers.push(() => db.close());
    expect(await db.get("notes", "Old.md")).toMatchObject({ text: "kept" });
    expect(await db.get("values", "theme")).toBe("dark");
    expect(db.objectStoreNames.contains("attachments")).toBe(true);
    expect(db.objectStoreNames.contains("sealed")).toBe(true);
  });

  it("asks to close other tabs when an old connection blocks the upgrade", async () => {
    const name = crypto.randomUUID();
    const old = await openDB(name, 2, {
      upgrade(db) {
        db.createObjectStore("notes", { keyPath: "path" });
        db.createObjectStore("values");
        db.createObjectStore("attachments", { keyPath: "path" });
      },
    });
    // The old connection ignores versionchange, like a tab running an older release.
    await expect(openDatabase(name)).rejects.toThrow(
      "Close other MarkNotes tabs, then reload to upgrade storage.",
    );
    old.close();
  });

  it("closes itself and warns when another tab upgrades storage", async () => {
    const name = crypto.randomUUID();
    const db = await openDatabase(name);
    const warned = new Promise<string>((resolve) =>
      window.addEventListener(
        "marknotes:error",
        (event) => resolve(String((event as CustomEvent<unknown>).detail)),
        { once: true },
      ),
    );
    const newer = await openDB(name, DB_VERSION + 1);
    closers.push(() => newer.close());
    expect(await warned).toContain("Storage changed in another tab");
    // A closed connection can no longer start transactions.
    expect(() => db.transaction("notes")).toThrow();
  });
});

function contract(name: string, make: () => Promise<Backend>) {
  describe(`${name} transactions`, () => {
    it("reads, writes, lists and deletes records", async () => {
      const backend = await make();
      await backend.tx(["notes", "values"], "readwrite", async (tx) => {
        await tx.put("notes", note("b.md", "B"));
        await tx.put("notes", note("a.md", "A"));
        await tx.put("values", { on: true }, "flag");
      });
      expect(
        await backend.tx(["notes", "values"], "readonly", async (tx) => ({
          a: (await tx.get("notes", "a.md"))?.text,
          missing: await tx.get("notes", "c.md"),
          keys: await tx.keys("notes"),
          all: (await tx.getAll("notes")).map((n) => n.path),
          flag: await tx.get("values", "flag"),
        })),
      ).toEqual({
        a: "A",
        missing: undefined,
        keys: ["a.md", "b.md"],
        all: ["a.md", "b.md"],
        flag: { on: true },
      });
      await backend.tx(["notes"], "readwrite", (tx) =>
        tx.delete("notes", "a.md"),
      );
      expect(
        await backend.tx(["notes"], "readonly", (tx) => tx.keys("notes")),
      ).toEqual(["b.md"]);
    });

    it("rejects adding an existing key and rolls the transaction back", async () => {
      const backend = await make();
      await backend.tx(["notes"], "readwrite", (tx) =>
        tx.add("notes", note("a.md", "first")),
      );
      await expect(
        backend.tx(["notes"], "readwrite", async (tx) => {
          await tx.put("notes", note("b.md"));
          await tx.add("notes", note("a.md", "second"));
        }),
      ).rejects.toMatchObject({ name: "ConstraintError" });
      expect(
        await backend.tx(["notes"], "readonly", async (tx) => ({
          a: (await tx.get("notes", "a.md"))?.text,
          keys: await tx.keys("notes"),
        })),
      ).toEqual({ a: "first", keys: ["a.md"] });
    });

    it("discards every write when the work throws", async () => {
      const backend = await make();
      await expect(
        backend.tx(["values"], "readwrite", async (tx) => {
          await tx.put("values", 1, "one");
          throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      expect(
        await backend.tx(["values"], "readonly", (tx) => tx.keys("values")),
      ).toEqual([]);
    });

    it("dumps every record as writes", async () => {
      const backend = await make();
      await backend.tx(["notes", "values"], "readwrite", async (tx) => {
        await tx.put("notes", note("a.md", "A"));
        await tx.put("values", "x", "k");
      });
      expect(await dump(backend)).toEqual([
        { store: "notes", key: "a.md", value: note("a.md", "A") },
        { store: "values", key: "k", value: "x" },
      ]);
    });
  });
}
contract("IndexedDB", idbBackend);
contract("memory", async () => new MemoryBackend());

describe("MemoryBackend", () => {
  it("refuses writes in read-only transactions", async () => {
    const backend = new MemoryBackend();
    await expect(
      backend.tx(["values"], "readonly", (tx) => tx.put("values", 1, "k")),
    ).rejects.toThrow("Read-only transaction.");
  });

  it("returns copies so callers cannot mutate stored records", async () => {
    const backend = new MemoryBackend();
    const value = { list: [1] };
    await backend.tx(["values"], "readwrite", (tx) =>
      tx.put("values", value, "k"),
    );
    value.list.push(2);
    const read = (await backend.tx(["values"], "readonly", (tx) =>
      tx.get("values", "k"),
    )) as { list: number[] };
    read.list.push(3);
    expect(
      await backend.tx(["values"], "readonly", (tx) => tx.get("values", "k")),
    ).toEqual({ list: [1] });
  });

  it("sees its own staged writes and deletions inside a transaction", async () => {
    const backend = new MemoryBackend();
    backend.load([
      { store: "notes", key: "a.md", value: note("a.md") },
      { store: "notes", key: "c.md", value: note("c.md") },
    ]);
    const seen = await backend.tx(["notes"], "readwrite", async (tx) => {
      await tx.delete("notes", "a.md");
      await tx.put("notes", note("b.md"));
      return {
        keys: await tx.keys("notes"),
        a: await tx.get("notes", "a.md"),
      };
    });
    expect(seen).toEqual({ keys: ["b.md", "c.md"], a: undefined });
    // Adding a key deleted earlier in the same transaction is allowed.
    await backend.tx(["notes"], "readwrite", async (tx) => {
      await tx.delete("notes", "c.md");
      await tx.add("notes", note("c.md", "again"));
    });
    expect(
      (await backend.tx(["notes"], "readonly", (tx) => tx.get("notes", "c.md")))
        ?.text,
    ).toBe("again");
  });

  it("persists staged changes before applying them, and only once", async () => {
    const persisted: Change[][] = [];
    const backend = new MemoryBackend(async (changes) => {
      persisted.push(changes);
    });
    await backend.tx(["values"], "readwrite", async (tx) => {
      await tx.put("values", 1, "k");
      await tx.put("values", 2, "k");
      await tx.delete("values", "gone");
    });
    // Read-only work and writes that change nothing are not persisted.
    await backend.tx(["values"], "readwrite", (tx) => tx.get("values", "k"));
    expect(persisted).toEqual([
      [
        { store: "values", key: "k", value: 2 },
        { store: "values", key: "gone", deleted: true },
      ],
    ]);
  });

  it("keeps memory unchanged when persisting fails, and keeps serving later writes", async () => {
    const persist = vi
      .fn<(changes: Change[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue();
    const backend = new MemoryBackend(persist);
    await expect(
      backend.tx(["values"], "readwrite", (tx) => tx.put("values", 1, "a")),
    ).rejects.toThrow("disk full");
    await backend.tx(["values"], "readwrite", (tx) => tx.put("values", 2, "b"));
    expect(await dump(backend)).toEqual([
      { store: "values", key: "b", value: 2 },
    ]);
  });

  it("serialises write transactions", async () => {
    const backend = new MemoryBackend();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = backend.tx(["values"], "readwrite", async (tx) => {
      order.push("first:start");
      await gate;
      await tx.put("values", "first", "k");
      order.push("first:end");
    });
    const second = backend.tx(["values"], "readwrite", async (tx) => {
      order.push(`second:${String(await tx.get("values", "k"))}`);
      await tx.put("values", "second", "k");
    });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:first"]);
  });

  it("loads deletions and ignores close", () => {
    const backend = new MemoryBackend();
    backend.load([
      { store: "values", key: "a", value: 1 },
      { store: "values", key: "a", deleted: true },
    ]);
    backend.close();
    return expect(dump(backend)).resolves.toEqual([]);
  });
});
