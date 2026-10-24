import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectSync, type ReconnectResult } from "../js/reconnect";
import { ApiError } from "../js/auth";
import { ReconnectRequired, SyncError, syncFailure } from "../js/sync-errors";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(result: ReconnectResult = { state: "complete" }) {
  const attempt = vi
    .fn<() => Promise<ReconnectResult>>()
    .mockResolvedValue(result);
  const status = vi.fn();
  const error = vi.fn();
  const scheduler = new ReconnectSync(true, attempt, status, error);
  scheduler.update({ available: true });
  const reconnect = () => {
    scheduler.update({ online: false });
    scheduler.update({ online: true });
  };
  return { scheduler, attempt, status, error, reconnect };
}

describe("foreground reconnect scheduling", () => {
  it("is off by default and does not sync just because it is enabled", async () => {
    const { scheduler, reconnect, attempt } = setup();
    reconnect();
    await vi.runAllTimersAsync();
    expect(attempt).not.toHaveBeenCalled();
    scheduler.update({ enabled: true });
    await vi.runAllTimersAsync();
    expect(attempt).not.toHaveBeenCalled();
    reconnect();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("coalesces flapping without resetting the finite retry budget", async () => {
    const { scheduler, reconnect, attempt, status } = setup({ state: "retry" });
    scheduler.update({ enabled: true });
    reconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    reconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    reconnect();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(status).toHaveBeenLastCalledWith(
      expect.stringContaining("exhausted"),
    );
  });

  it("waits without polling when hidden, offline, busy or holding a chord draft", async () => {
    const { scheduler, reconnect, attempt } = setup();
    scheduler.update({ enabled: true, visible: false });
    reconnect();
    await vi.runAllTimersAsync();
    expect(attempt).not.toHaveBeenCalled();
    scheduler.update({ visible: true, available: false });
    await vi.runAllTimersAsync();
    expect(attempt).not.toHaveBeenCalled();
    scheduler.update({ available: true, online: false });
    await vi.runAllTimersAsync();
    expect(attempt).not.toHaveBeenCalled();
    scheduler.update({ online: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("honors provider cooldowns and does not reset them on visibility changes", async () => {
    const { scheduler, reconnect, attempt } = setup({
      state: "retry",
      retryAt: Date.now() + 60_000,
    });
    scheduler.update({ enabled: true });
    reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    scheduler.update({ visible: false });
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.update({ visible: true });
    await vi.advanceTimersByTimeAsync(47_999);
    expect(attempt).toHaveBeenCalledTimes(1);
    attempt.mockResolvedValue({ state: "complete" });
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("bounds lock-contention deferrals and stops on permanent/auth failures", async () => {
    const { scheduler, reconnect, attempt } = setup({ state: "deferred" });
    scheduler.update({ enabled: true });
    reconnect();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(4);
    attempt.mockResolvedValue({ state: "stop" });
    reconnect();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it("never overlaps and ignores late results after opt-out or manual cancellation", async () => {
    let finish!: (result: ReconnectResult) => void;
    const { scheduler, reconnect, attempt } = setup();
    attempt.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    scheduler.update({ enabled: true });
    reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    reconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    scheduler.update({ enabled: false });
    finish({ state: "retry" });
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(1);
    scheduler.update({ enabled: true });
    reconnect();
    scheduler.cancel();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(1);
    reconnect();
    scheduler.destroy();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces unexpected callback errors and does not retry them", async () => {
    const { scheduler, reconnect, attempt, error } = setup();
    const failure = new Error("save failed");
    attempt.mockRejectedValue(failure);
    scheduler.update({ enabled: true });
    reconnect();
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledWith(failure);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("typed retry policy", () => {
  it("never guesses retryability from error text", () => {
    expect(syncFailure(new Error("network timeout 503 reconnect"))).toEqual({
      kind: "permanent",
    });
    expect(syncFailure(new ApiError(401, "Dropbox")).kind).toBe(
      "authentication",
    );
    expect(syncFailure(new ApiError(403, "Dropbox")).kind).toBe(
      "authentication",
    );
    expect(syncFailure(new ApiError(500, "Dropbox")).kind).toBe("transient");
    expect(syncFailure(new ApiError(409, "Dropbox")).kind).toBe("permanent");
    expect(syncFailure(new ReconnectRequired("sign in")).kind).toBe(
      "authentication",
    );
    expect(
      syncFailure(
        new SyncError("cooldown", { kind: "transient", retryAt: 123 }),
      ),
    ).toEqual({ kind: "transient", retryAt: 123 });
  });
});
