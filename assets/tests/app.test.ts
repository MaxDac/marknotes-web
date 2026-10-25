// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicConfig } from "../js/auth";

const mocks = vi.hoisted(() => ({
  instances: [] as {
    root: HTMLElement;
    config: unknown;
    start: ReturnType<typeof vi.fn>;
    prepareUpdate: ReturnType<typeof vi.fn>;
    recordDiagnostic: ReturnType<typeof vi.fn>;
  }[],
  start: undefined as undefined | (() => Promise<void>),
  loadConfig: vi.fn<() => Promise<unknown>>(),
  startPwa: vi.fn<(prepare: () => Promise<void>) => Promise<void>>(),
  pwaStatus: vi.fn<(text: string) => void>(),
}));
vi.mock("../js/ui", () => ({
  NotesUI: class {
    start = vi.fn(() => mocks.start?.() ?? Promise.resolve());
    prepareUpdate = vi.fn(() => Promise.resolve());
    recordDiagnostic = vi.fn();
    constructor(
      readonly root: HTMLElement,
      readonly config: unknown,
    ) {
      mocks.instances.push(this);
    }
  },
}));
vi.mock("../js/config", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../js/pwa", () => ({
  startPwa: mocks.startPwa,
  pwaStatus: mocks.pwaStatus,
}));
vi.mock("../css/app.css", () => ({}));

const config: PublicConfig = { dropbox: "key", onedrive: "client" };
let root: HTMLElement;
let listeners: [string, EventListenerOrEventListenerObject][];

/** Imports app.ts afresh and waits until startup has either finished or rendered its alert. */
async function boot(): Promise<void> {
  vi.resetModules();
  await import("../js/app");
  await vi.waitFor(() => {
    const ui = mocks.instances[0];
    if (!root.querySelector("[role=alert]"))
      expect(ui?.start).toHaveBeenCalled();
  });
}

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.start = undefined;
  mocks.loadConfig.mockReset().mockResolvedValue(config);
  mocks.startPwa.mockReset().mockResolvedValue();
  mocks.pwaStatus.mockReset();
  root = document.createElement("div");
  root.id = "marknotes";
  document.body.append(root);
  listeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.push([type, listener]);
      add(type, listener);
    },
  );
});

afterEach(() => {
  for (const [type, listener] of listeners)
    window.removeEventListener(type, listener);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("app startup", () => {
  it("mounts the UI on #marknotes with the loaded config and starts it", async () => {
    await boot();
    expect(mocks.instances).toHaveLength(1);
    const ui = mocks.instances[0]!;
    expect(ui.root).toBe(root);
    expect(ui.config).toBe(config);
    expect(ui.start).toHaveBeenCalledTimes(1);
    expect(root.querySelector("[role=alert]")).toBeNull();
    expect(ui.recordDiagnostic).not.toHaveBeenCalled();

    // The PWA asks the UI to prepare (save, check other tabs) before updating.
    expect(mocks.startPwa).toHaveBeenCalledTimes(1);
    const prepare = mocks.startPwa.mock.calls[0]![0];
    await prepare();
    expect(ui.prepareUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows PWA errors raised as window events", async () => {
    await boot();
    window.dispatchEvent(
      new CustomEvent("marknotes:pwa-error", { detail: "Update failed" }),
    );
    expect(mocks.pwaStatus).toHaveBeenCalledWith("Update failed");
    window.dispatchEvent(new CustomEvent("marknotes:pwa-error"));
    expect(mocks.pwaStatus).toHaveBeenLastCalledWith("null");
  });

  it("renders an alert and records a diagnostic when the UI fails to start", async () => {
    mocks.start = () => Promise.reject(new Error("storage unavailable"));
    await boot();
    await vi.waitFor(() =>
      expect(root.querySelector("[role=alert]")).not.toBeNull(),
    );
    expect(root.querySelector("[role=alert]")!.textContent).toBe(
      "MarkNotes could not initialize: storage unavailable",
    );
    expect(mocks.instances[0]!.recordDiagnostic).toHaveBeenCalledWith(
      "initialization-failed",
    );
  });

  it("renders an alert without a UI when the config cannot be loaded", async () => {
    mocks.loadConfig.mockRejectedValue("bad config");
    await boot();
    expect(root.querySelector("[role=alert]")!.textContent).toBe(
      "MarkNotes could not initialize: bad config",
    );
    expect(mocks.instances).toHaveLength(0);
    expect(mocks.startPwa).not.toHaveBeenCalled();
  });
});
