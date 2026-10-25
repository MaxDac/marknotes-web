// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOfflineApp, pwaStatus, startPwa } from "../js/pwa";

const config = vi.hoisted(() => ({
  cached: true,
  forgotten: false,
  disable: vi.fn(),
}));

vi.mock("../js/config", () => ({
  PUBLIC_CACHE_LOCK: "marknotes:public-cache",
  get publicConfigCached() {
    return config.cached;
  },
  get deviceForgotten() {
    return config.forgotten;
  },
  disablePublicCache: config.disable,
}));

class FakeWorker extends EventTarget {
  postMessage = vi.fn();
  constructor(public state: ServiceWorkerState) {
    super();
  }
  become(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  constructor(public scope = "https://notes.example/") {
    super();
  }
  unregister = vi.fn(async () => true);
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
  getRegistrations = vi.fn(async (): Promise<FakeRegistration[]> => []);
}

let container: FakeContainer;
let lockRequest: ReturnType<typeof vi.fn>;
let put: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;

function status(): string {
  return document.querySelector("#pwa-status p")?.textContent ?? "";
}

function actionButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("#pwa-status button");
}

beforeEach(() => {
  config.cached = true;
  config.forgotten = false;
  config.disable.mockReset();
  document.body.innerHTML = '<div id="pwa-status"></div>';
  container = new FakeContainer();
  lockRequest = vi.fn((_name: string, work: () => Promise<unknown>) => work());
  put = vi.fn(async () => undefined);
  open = vi.fn(async () => ({ put }));
  reload = vi.fn();
  vi.stubGlobal("navigator", {
    locks: { request: lockRequest },
    serviceWorker: container,
  });
  vi.stubGlobal("caches", { open });
  vi.stubGlobal("location", { origin: "https://notes.example", reload });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("pwaStatus", () => {
  it("does nothing without a status region", () => {
    document.body.replaceChildren();
    expect(() => pwaStatus("Hello")).not.toThrow();
    expect(document.body.childElementCount).toBe(0);
  });

  it("replaces the previous message and only offers a button with an action", () => {
    pwaStatus("First", async () => undefined);
    expect(actionButton()?.textContent).toBe("Save and update");
    pwaStatus("Second");
    expect(status()).toBe("Second");
    expect(document.querySelectorAll("#pwa-status p")).toHaveLength(1);
    expect(actionButton()).toBeNull();
  });

  it("disables the button while the action runs", async () => {
    const action = vi.fn(async () => undefined);
    pwaStatus("Ready", action);
    const button = actionButton()!;
    button.click();
    expect(button.disabled).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(status()).toBe("Ready");
  });

  it("postpones a failed update and offers it again", async () => {
    const action = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Unsaved note"))
      .mockRejectedValueOnce("busy")
      .mockResolvedValue(undefined);
    pwaStatus("Ready", action);
    actionButton()!.click();
    await vi.waitFor(() =>
      expect(status()).toBe("Update postponed: Unsaved note"),
    );
    expect(actionButton()?.disabled).toBe(false);
    actionButton()!.click();
    await vi.waitFor(() => expect(status()).toBe("Update postponed: busy"));
    actionButton()!.click();
    expect(action).toHaveBeenCalledTimes(3);
  });
});

describe("startPwa", () => {
  const prepare = () => vi.fn(async () => vi.fn());

  it("explains when the browser has no service workers", async () => {
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    await startPwa(prepare());
    expect(status()).toBe(
      "Offline launch is unavailable in this browser. Online editing still works.",
    );
    expect(lockRequest).not.toHaveBeenCalled();
  });

  it("does not register when the public configuration was not cached", async () => {
    config.cached = false;
    await startPwa(prepare());
    expect(status()).toMatch(
      /^Offline preparation failed: The public configuration could not be cached\..*Online editing still works\.$/,
    );
    expect(container.register).not.toHaveBeenCalled();
  });

  it("does not re-enable offline use after the device was forgotten", async () => {
    config.forgotten = true;
    await startPwa(prepare());
    expect(lockRequest).toHaveBeenCalledWith(
      "marknotes:public-cache",
      expect.any(Function),
    );
    expect(open).not.toHaveBeenCalled();
    expect(container.register).not.toHaveBeenCalled();
    expect(status()).toContain("This device was forgotten.");
  });

  it("reports registration failures without breaking online editing", async () => {
    container.register.mockRejectedValue("blocked");
    await startPwa(prepare());
    expect(status()).toBe(
      "Offline preparation failed: blocked. Online editing still works.",
    );
  });

  it("marks offline use enabled and registers the module worker inside the lock", async () => {
    const order: string[] = [];
    lockRequest.mockImplementation(
      async (_name: string, work: () => Promise<unknown>) => {
        order.push("locked");
        const result = await work();
        order.push("released");
        return result;
      },
    );
    put.mockImplementation(async () => void order.push("marker"));
    container.register.mockImplementation(async () => {
      order.push("register");
      return container.registration;
    });
    container.registration.active = new FakeWorker("activated");
    await startPwa(prepare());
    expect(open).toHaveBeenCalledWith("marknotes-offline-control");
    expect(put).toHaveBeenCalledWith("/offline-enabled", expect.any(Response));
    expect(await (put.mock.calls[0]![1] as Response).text()).toBe("enabled");
    expect(container.register).toHaveBeenCalledWith("/sw.js", {
      type: "module",
      updateViaCache: "none",
    });
    expect(order).toEqual(["locked", "marker", "register", "released"]);
    expect(status()).toBe("MarkNotes is ready offline.");
  });

  it("reports readiness once the first worker installs", async () => {
    const worker = new FakeWorker("installing");
    container.registration.installing = worker;
    await startPwa(prepare());
    expect(status()).toBe("");
    worker.become("installed");
    expect(status()).toBe("MarkNotes is ready offline.");
    expect(actionButton()).toBeNull();
  });

  it("reports a redundant installing worker", async () => {
    const worker = new FakeWorker("installing");
    container.registration.installing = worker;
    await startPwa(prepare());
    worker.become("redundant");
    expect(status()).toBe(
      "Offline preparation failed. Keep this tab open and retry online.",
    );
  });

  it("offers a found update when this page is already controlled", async () => {
    container.controller = new FakeWorker("activated");
    await startPwa(prepare());
    expect(status()).toBe("");
    const worker = new FakeWorker("installing");
    container.registration.installing = worker;
    container.registration.dispatchEvent(new Event("updatefound"));
    worker.become("installed");
    // Installed but not waiting: nothing to activate yet.
    expect(status()).toBe("");
    container.registration.waiting = worker;
    worker.become("installed");
    expect(status()).toBe(
      "A MarkNotes update is ready. Save your work before updating.",
    );
    expect(actionButton()?.textContent).toBe("Save and update");
  });

  it("ignores an update event without an installing worker", async () => {
    container.registration.active = new FakeWorker("activated");
    await startPwa(prepare());
    container.registration.dispatchEvent(new Event("updatefound"));
    expect(status()).toBe("MarkNotes is ready offline.");
  });

  describe("update activation", () => {
    let waiting: FakeWorker;
    let resume: ReturnType<typeof vi.fn>;
    let save: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      waiting = new FakeWorker("installed");
      container.registration.active = new FakeWorker("activated");
      container.registration.waiting = waiting;
      resume = vi.fn();
      save = vi.fn(async () => resume);
      await startPwa(save as unknown as () => Promise<() => void>);
      expect(status()).toBe(
        "A MarkNotes update is ready. Save your work before updating.",
      );
    });

    it("saves, activates the waiting worker and reloads on controller change", async () => {
      const remove = vi.spyOn(container, "removeEventListener");
      actionButton()!.click();
      await vi.waitFor(() =>
        expect(waiting.postMessage).toHaveBeenCalledWith("ACTIVATE_UPDATE"),
      );
      expect(save).toHaveBeenCalledOnce();
      expect(reload).not.toHaveBeenCalled();
      container.dispatchEvent(new Event("controllerchange"));
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      expect(resume).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith(
        "controllerchange",
        expect.any(Function),
      );
      container.dispatchEvent(new Event("controllerchange"));
      expect(reload).toHaveBeenCalledOnce();
    });

    it("refuses when the waiting worker disappeared before saving", async () => {
      container.registration.waiting = null;
      actionButton()!.click();
      await vi.waitFor(() =>
        expect(status()).toBe(
          "Update postponed: The update is no longer available. Reload online to check again.",
        ),
      );
      expect(save).not.toHaveBeenCalled();
    });

    it("does not activate when saving fails", async () => {
      save.mockRejectedValue(new Error("Save failed"));
      actionButton()!.click();
      await vi.waitFor(() =>
        expect(status()).toBe("Update postponed: Save failed"),
      );
      expect(waiting.postMessage).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });

    it("resumes editing when activation times out", async () => {
      vi.useFakeTimers();
      const remove = vi.spyOn(container, "removeEventListener");
      actionButton()!.click();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(waiting.postMessage).toHaveBeenCalledWith("ACTIVATE_UPDATE");
      expect(resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resume).toHaveBeenCalledOnce();
      expect(status()).toBe(
        "Update postponed: Update activation timed out. Try again online.",
      );
      expect(remove).toHaveBeenCalledWith(
        "controllerchange",
        expect.any(Function),
      );
      container.dispatchEvent(new Event("controllerchange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).not.toHaveBeenCalled();
      expect(actionButton()?.disabled).toBe(false);
    });
  });
});

describe("clearOfflineApp", () => {
  it("disables the cache first and unregisters only this origin's root worker", async () => {
    const order: string[] = [];
    config.disable.mockImplementation(() => order.push("disabled"));
    lockRequest.mockImplementation(
      async (_name: string, work: () => Promise<unknown>) => {
        order.push("locked");
        await work();
      },
    );
    const own = new FakeRegistration("https://notes.example/");
    const nested = new FakeRegistration("https://notes.example/docs/");
    container.getRegistrations.mockResolvedValue([nested, own]);
    const deleted: string[] = [];
    vi.stubGlobal("caches", {
      keys: async () => ["marknotes-shell", "marknotes-offline-control"],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
    });
    await clearOfflineApp();
    expect(order).toEqual(["disabled", "locked"]);
    expect(own.unregister).toHaveBeenCalledOnce();
    expect(nested.unregister).not.toHaveBeenCalled();
    expect(deleted).toEqual(["marknotes-shell", "marknotes-offline-control"]);
  });

  it("still forgets the cache flag without service workers or Cache Storage", async () => {
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    vi.stubGlobal("caches", undefined);
    await expect(clearOfflineApp()).resolves.toBeUndefined();
    expect(config.disable).toHaveBeenCalledOnce();
    expect(lockRequest).toHaveBeenCalledWith(
      "marknotes:public-cache",
      expect.any(Function),
    );
  });
});
