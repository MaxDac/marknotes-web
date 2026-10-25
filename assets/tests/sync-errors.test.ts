import { describe, expect, it } from "vitest";
import { ReconnectRequired, SyncError, syncFailure } from "../js/sync-errors";

describe("sync errors", () => {
  it("keeps the failure kind, retry time and cause", () => {
    const cause = new Error("429");
    const error = new SyncError(
      "Rate limited",
      { kind: "transient", retryAt: 1234 },
      { cause },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Rate limited");
    expect(error.cause).toBe(cause);
    expect(syncFailure(error)).toEqual({ kind: "transient", retryAt: 1234 });
  });

  it("classifies reconnect requests as authentication failures", () => {
    const error = new ReconnectRequired("Reconnect Dropbox", {
      cause: "revoked",
    });
    expect(error).toBeInstanceOf(SyncError);
    expect(error.cause).toBe("revoked");
    expect(syncFailure(error)).toEqual({ kind: "authentication" });
  });

  it("treats every other error as permanent", () => {
    for (const error of [new Error("boom"), "text", undefined, { kind: "x" }])
      expect(syncFailure(error)).toEqual({ kind: "permanent" });
  });
});
