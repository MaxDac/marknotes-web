import type { Backend } from "./backend";

export const DIAGNOSTICS_KEY = "diagnostics";
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_DRAFT_URL = 2000;
// Leave room for the sealed-record envelope, AES-GCM tag, IV and opaque key.
const PAYLOAD_BYTES = MAX_BYTES - 256;
const codes = {
  "action-failed": "application",
  "save-failed": "storage",
  "initialization-failed": "application",
  "uncaught-error": "application",
  "unhandled-rejection": "application",
  "storage-changed": "storage",
  "offline-update-failed": "offline",
  "sync-transient": "sync",
  "sync-authentication": "sync",
  "sync-permanent": "sync",
} as const;
export type DiagnosticCode = keyof typeof codes;
export interface DiagnosticRecord {
  time: number;
  category: (typeof codes)[DiagnosticCode];
  code: DiagnosticCode;
}
interface State {
  records: DiagnosticRecord[];
  snapshot?: { time: number; records: DiagnosticRecord[] };
}
const size = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const allowed = (code: unknown): code is DiagnosticCode =>
  typeof code === "string" && Object.hasOwn(codes, code);

function records(value: unknown, now: number): DiagnosticRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const r = item as Partial<DiagnosticRecord>;
      if (
        !allowed(r.code) ||
        typeof r.time !== "number" ||
        !Number.isSafeInteger(r.time) ||
        r.time < now - RETENTION_MS ||
        r.time > now
      )
        return [];
      // Reconstruct, never copy arbitrary fields from disk into an export.
      return [{ time: r.time, category: codes[r.code], code: r.code }];
    })
    .sort((a, b) => a.time - b.time);
}

function prune(value: unknown, now: number): State {
  const input =
    value && typeof value === "object" ? (value as Partial<State>) : {};
  const state: State = { records: records(input.records, now) };
  const snapshot = input.snapshot;
  if (
    snapshot &&
    Number.isSafeInteger(snapshot.time) &&
    snapshot.time >= now - RETENTION_MS &&
    snapshot.time <= now
  )
    state.snapshot = {
      time: snapshot.time,
      records: records(snapshot.records, now),
    };
  if (size(state) > PAYLOAD_BYTES) delete state.snapshot;
  let bytes = size(state);
  let removed = 0;
  while (bytes > PAYLOAD_BYTES && removed < state.records.length) {
    bytes -=
      size(state.records[removed]) +
      (state.records.length - removed > 1 ? 1 : 0);
    removed++;
  }
  if (removed) state.records = state.records.slice(removed);
  return state;
}

/** Only fixed codes enter the logger; exception objects and messages are never accepted. */
export class Diagnostics {
  private active = true;
  constructor(
    private backend: Backend,
    private now = Date.now,
  ) {}
  private async change<T>(work: (state: State, now: number) => T): Promise<T> {
    if (!this.active)
      throw new Error("Diagnostics are unavailable while storage is closed.");
    return this.backend.tx(["values"], "readwrite", async (tx) => {
      const now = this.now();
      const state = prune(await tx.get("values", DIAGNOSTICS_KEY), now);
      const result = work(state, now);
      await tx.put("values", prune(state, now), DIAGNOSTICS_KEY);
      return result;
    });
  }
  async prune(): Promise<void> {
    await this.change(() => {});
  }
  async record(code: DiagnosticCode): Promise<void> {
    if (!allowed(code)) throw new Error("Unknown diagnostic code.");
    await this.change((state, time) => {
      state.records.push({ time, category: codes[code], code });
    });
  }
  async clear(): Promise<void> {
    if (!this.active)
      throw new Error("Diagnostics are unavailable while storage is closed.");
    await this.backend.tx(["values"], "readwrite", (tx) =>
      tx.delete("values", DIAGNOSTICS_KEY),
    );
  }
  async recent(): Promise<DiagnosticRecord[]> {
    return this.change((state) => state.records);
  }
  async export(): Promise<string> {
    return this.change((state, time) => {
      // Replacing the previous snapshot keeps log + export storage within one budget.
      delete state.snapshot;
      let bytes = size({
        records: state.records,
        snapshot: { time, records: state.records },
      });
      let removed = 0;
      while (bytes > PAYLOAD_BYTES && removed < state.records.length) {
        bytes -=
          2 *
          (size(state.records[removed]) +
            (state.records.length - removed > 1 ? 1 : 0));
        removed++;
      }
      state.records = state.records.slice(removed);
      state.snapshot = { time, records: state.records };
      return JSON.stringify(state.snapshot);
    });
  }
  async suspend(): Promise<() => void> {
    if (!this.active) throw new Error("Diagnostics storage is closed.");
    this.active = false;
    try {
      // A write barrier drains pending log writes before a storage-mode migration.
      await this.backend.tx(["values"], "readwrite", async () => {});
    } catch (error) {
      this.active = true;
      throw error;
    }
    return () => {
      this.active = true;
    };
  }
  close(): void {
    this.active = false;
  }
}

export function issueDraft(
  input: DiagnosticRecord[],
  now = Date.now(),
): {
  url: string;
  body: string;
} {
  const safe = records(input, now).reverse();
  const bodyFor = (lines: string[], truncated: boolean) =>
    `MarkNotes Web problem\n\nDescribe what went wrong (do not include private notes or credentials):\n\nSanitized recent errors (newest first):\n${lines.length ? lines.join("\n") : "(none)"}\n${truncated ? "[Truncated: older records omitted]\n" : ""}`;
  const urlFor = (body: string) =>
    `https://github.com/MaxDac/marknotes-web/issues/new?title=${encodeURIComponent("MarkNotes Web problem")}&body=${encodeURIComponent(body)}`;
  const lines: string[] = [];
  for (let i = 0; i < safe.length; i++) {
    const r = safe[i];
    const line = `${new Date(r.time).toISOString()} ${r.category} ${r.code}`;
    if (
      urlFor(bodyFor([...lines, line], i + 1 < safe.length)).length >
      MAX_DRAFT_URL
    )
      break;
    lines.push(line);
  }
  const body = bodyFor(lines, lines.length < safe.length);
  return { url: urlFor(body), body };
}
