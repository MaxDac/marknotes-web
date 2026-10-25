import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../js/backend";
import {
  Diagnostics,
  DIAGNOSTICS_KEY,
  issueDraft,
  MAX_BYTES,
  MAX_DRAFT_URL,
  RETENTION_MS,
  type DiagnosticRecord,
} from "../js/diagnostics";
import { Store } from "../js/storage";
import { Session } from "../js/security";
import { openDB } from "idb";

const NOW = Date.UTC(2026, 9, 24);
const record = (time = NOW): DiagnosticRecord => ({
  time,
  category: "storage",
  code: "save-failed",
});
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("local diagnostics", () => {
  it("accepts only fixed codes, reconstructs disk records, and never exports private fields", async () => {
    const store = new Store(new MemoryBackend());
    const logs = new Diagnostics(store.backend, () => NOW);
    await expect(
      logs.record("SECRET_PATH token" as "save-failed"),
    ).rejects.toThrow("Unknown");
    await store.put(DIAGNOSTICS_KEY, {
      records: [
        {
          ...record(),
          category: "SECRET_ACCOUNT",
          message: "SECRET_NOTE",
          path: "SECRET_PATH",
          token: "SECRET_TOKEN",
        },
        { ...record(), code: "SECRET_CODE" },
        { ...record(), time: NaN },
        { ...record(), time: NOW + 1 },
      ],
      snapshot: {
        time: NOW,
        records: [{ ...record(), stack: "SECRET_STACK" }],
      },
      secret: "SECRET_ID",
    });
    await logs.record("action-failed");
    const exported = await logs.export();
    expect(exported).not.toContain("SECRET");
    expect(JSON.parse(exported).records).toEqual([
      record(),
      { time: NOW, category: "application", code: "action-failed" },
    ]);
    expect(await store.value(DIAGNOSTICS_KEY)).not.toHaveProperty("secret");
    expect(issueDraft(JSON.parse(exported).records, NOW).body).not.toContain(
      "SECRET",
    );
  });

  it("prunes on startup, write, review and export, including old export records", async () => {
    const store = new Store(new MemoryBackend());
    let now = NOW;
    const logs = new Diagnostics(store.backend, () => now);
    const seed = async () =>
      store.put(DIAGNOSTICS_KEY, {
        records: [
          record(NOW - RETENTION_MS - 1),
          record(NOW - RETENTION_MS),
          record(),
        ],
        snapshot: { time: NOW - RETENTION_MS - 1, records: [record()] },
      });
    await seed();
    await logs.prune();
    expect(await logs.recent()).toEqual([record(NOW - RETENTION_MS), record()]);
    expect(await store.value(DIAGNOSTICS_KEY)).not.toHaveProperty("snapshot");
    now++;
    await logs.record("action-failed");
    expect(await logs.recent()).toHaveLength(2);
    now += RETENTION_MS + 1;
    expect(JSON.parse(await logs.export()).records).toEqual([]);
    await seed();
    expect(await logs.recent()).toEqual([]);
  });

  it("enforces the exact combined 5 MiB budget on writes and full exports", async () => {
    const store = new Store(new MemoryBackend());
    const logs = new Diagnostics(store.backend, () => NOW);
    const many = Array.from({ length: 75000 }, (_, i) =>
      record(NOW - 75000 + i),
    );
    await store.put(DIAGNOSTICS_KEY, { records: many });
    await logs.record("action-failed");
    expect(bytes(await store.value(DIAGNOSTICS_KEY))).toBeLessThanOrEqual(
      MAX_BYTES - 256,
    );
    const exported = JSON.parse(await logs.export()) as {
      records: DiagnosticRecord[];
    };
    const stored = await store.value<{
      records: DiagnosticRecord[];
      snapshot: unknown;
    }>(DIAGNOSTICS_KEY);
    expect(stored!.records.length).toBeLessThan(many.length);
    expect(stored!.records.at(-1)?.code).toBe("action-failed");
    expect(exported.records).toEqual(stored!.records);
    expect(bytes(stored)).toBeLessThanOrEqual(MAX_BYTES - 256);
    await logs.clear();
    expect(await store.value(DIAGNOSTICS_KEY)).toBeUndefined();
    expect(await logs.recent()).toEqual([]);
  }, 15_000);

  it("serializes concurrent writes across logger instances without losing records", async () => {
    const backend = new MemoryBackend();
    const a = new Diagnostics(backend, () => NOW);
    const b = new Diagnostics(backend, () => NOW);
    await Promise.all(
      Array.from({ length: 30 }, () => a.record("save-failed")),
    );
    await Promise.all(
      Array.from({ length: 30 }, () => b.record("action-failed")),
    );
    expect(await a.recent()).toHaveLength(60);
  });

  it("surfaces persistence failure and does not use an alternate plaintext store", async () => {
    const logs = new Diagnostics(
      new MemoryBackend(async () => {
        throw new Error("disk full");
      }),
    );
    await expect(logs.record("save-failed")).rejects.toThrow("disk full");
    logs.close();
    await expect(logs.record("save-failed")).rejects.toThrow("closed");
    await expect(logs.recent()).rejects.toThrow("closed");
    await expect(logs.export()).rejects.toThrow("closed");
    await expect(logs.clear()).rejects.toThrow("closed");
  });
});

describe("GitHub draft", () => {
  it("uses whole newest records within a complete 2000-ASCII-character URL and marks truncation", () => {
    const input = Array.from({ length: 100 }, (_, i) => record(NOW - i));
    const draft = issueDraft(input, NOW);
    expect(draft.url.length).toBeLessThanOrEqual(MAX_DRAFT_URL);
    expect(draft.url).toMatch(/^[\x20-\x7e]+$/);
    const url = new URL(draft.url);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/MaxDac/marknotes-web/issues/new",
    );
    expect(url.searchParams.get("body")).toBe(draft.body);
    expect(draft.body).toContain("[Truncated: older records omitted]");
    const lines = draft.body
      .split("\n")
      .filter((line) => line.startsWith("2026-"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(input.length);
    expect(lines[0]).toBe("2026-10-24T00:00:00.000Z storage save-failed");
    for (const line of lines)
      expect(line).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z storage save-failed$/,
      );
    expect(issueDraft([record()], NOW).body).not.toContain("Truncated");
    expect(issueDraft([], NOW).body).toContain("(none)");
    expect(issueDraft([record(NOW - RETENTION_MS - 1)], NOW).body).toContain(
      "(none)",
    );
  });
});

describe("diagnostics storage lifecycle", () => {
  it("prunes retained logs and snapshots when the device store opens", async () => {
    const name = crypto.randomUUID();
    const seed = await Store.open(name);
    await seed.put(DIAGNOSTICS_KEY, {
      records: [record(Date.now() - RETENTION_MS - 1000)],
      snapshot: { time: Date.now() - RETENTION_MS - 1000, records: [record()] },
    });
    seed.close();
    const session = await Session.open(name, 1000);
    try {
      expect(await (await session.store()).value(DIAGNOSTICS_KEY)).toEqual({
        records: [],
      });
    } finally {
      session.close();
    }
  });

  it("drains pending writes before changing mode and resumes diagnostics if migration fails", async () => {
    const session = await Session.open(crypto.randomUUID(), 1000);
    try {
      const store = await session.store();
      const pending = store.diagnostics.record("save-failed");
      await expect(session.switchTo("locked", "short")).rejects.toThrow(
        "at least",
      );
      await pending;
      await store.diagnostics.record("action-failed");
      expect(await store.diagnostics.recent()).toHaveLength(2);
      await session.switchTo("locked", "correct horse battery");
      await expect(store.diagnostics.record("save-failed")).rejects.toThrow(
        "closed",
      );
    } finally {
      session.close();
    }
  });

  it("migrates, seals, rekeys, unlocks, clears and forgets logs and export snapshots with the working set", async () => {
    const name = crypto.randomUUID();
    let session = await Session.open(name, 1000);
    try {
      let store = await session.store();
      await store.diagnostics.record("save-failed");
      await store.diagnostics.export();
      await session.switchTo("locked", "correct horse battery");
      session.close();
      const db = await openDB(name);
      expect(await db.getAll("values")).toEqual([]);
      const ciphertext = (await db.getAll("sealed"))
        .map((r: { bytes: ArrayBuffer }) => new TextDecoder().decode(r.bytes))
        .join("");
      expect(ciphertext).not.toContain("save-failed");
      expect(ciphertext).not.toContain("diagnostics");
      db.close();
      await expect(store.diagnostics.recent()).rejects.toThrow("closed");
      session = await Session.open(name, 1000);
      await expect(session.store()).rejects.toThrow("Unlock");
      await expect(session.unlock("wrong passphrase")).rejects.toThrow("Wrong");
      store = await session.unlock("correct horse battery");
      expect(await store.diagnostics.recent()).toHaveLength(1);
      await session.changePassphrase(
        "correct horse battery",
        "another long passphrase",
      );
      session.close();
      session = await Session.open(name, 1000);
      store = await session.unlock("another long passphrase");
      expect(await store.value(DIAGNOSTICS_KEY)).toHaveProperty("snapshot");
      await store.diagnostics.clear();
      expect(await store.value(DIAGNOSTICS_KEY)).toBeUndefined();
      await store.diagnostics.record("action-failed");
      await store.diagnostics.export();
      await session.forget();
      session = await Session.open(name, 1000);
      store = await session.store();
      expect(await store.diagnostics.recent()).toEqual([]);
      expect(await store.value(DIAGNOSTICS_KEY)).not.toHaveProperty("snapshot");
    } finally {
      session.close();
    }
  });

  it("keeps memory-mode logs and exports off disk and drops them on reload", async () => {
    const name = crypto.randomUUID();
    let session = await Session.open(name, 1000);
    try {
      const original = await session.store();
      await original.diagnostics.record("save-failed");
      await session.switchTo("ephemeral");
      session.close();
      session = await Session.open(name, 1000);
      const store = await session.store();
      expect(await store.diagnostics.recent()).toEqual([]);
      await store.diagnostics.record("uncaught-error");
      await store.diagnostics.export();
      const db = await openDB(name);
      expect(await db.getAll("values")).toEqual([]);
      expect(await db.getAll("sealed")).toEqual([]);
      db.close();
      session.close();
      session = await Session.open(name, 1000);
      expect(await (await session.store()).diagnostics.recent()).toEqual([]);
    } finally {
      session.close();
    }
  });
});
