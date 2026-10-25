import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const precache = vi.hoisted(() => ({
  options: undefined as unknown,
  addToCacheList: vi.fn(),
  install: vi.fn(),
  activate: vi.fn(),
  getCacheKeyForURL: vi.fn(),
}));

vi.mock("workbox-precaching", () => ({
  PrecacheController: class {
    constructor(options: unknown) {
      precache.options = options;
    }
    addToCacheList = precache.addToCacheList;
    install = precache.install;
    activate = precache.activate;
    getCacheKeyForURL = precache.getCacheKeyForURL;
  },
}));

type Handler = (event: unknown) => void;
const ORIGIN = "https://notes.example";
const manifest = [
  { url: "/index.html", revision: "1" },
  { url: "/security.html", revision: "2" },
];
let handlers: Record<string, Handler>;
let skipWaiting: ReturnType<typeof vi.fn>;
let match: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let lockRequest: ReturnType<typeof vi.fn>;

async function loadWorker(): Promise<void> {
  vi.resetModules();
  await import("../js/sw");
}

function lifecycle(type: "install" | "activate") {
  const waits: Promise<unknown>[] = [];
  const event = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  };
  handlers[type]!(event);
  expect(waits).toHaveLength(1);
  return { event, done: waits[0]! };
}

function request(url: string, method = "GET") {
  const event = {
    request: new Request(url, { method }),
    respondWith: vi.fn(),
  };
  handlers.fetch!(event);
  return event;
}

beforeEach(async () => {
  handlers = {};
  precache.options = undefined;
  precache.addToCacheList.mockReset();
  precache.install.mockReset().mockResolvedValue(undefined);
  precache.activate.mockReset().mockResolvedValue(undefined);
  precache.getCacheKeyForURL.mockReset();
  skipWaiting = vi.fn(async () => undefined);
  match = vi.fn(async () => undefined);
  fetchMock = vi.fn(async () => new Response("network"));
  lockRequest = vi.fn((_name: string, work: () => Promise<unknown>) => work());
  vi.stubGlobal("self", {
    __WB_MANIFEST: manifest,
    location: { origin: ORIGIN },
    skipWaiting,
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
  });
  vi.stubGlobal("caches", { match });
  vi.stubGlobal("navigator", { locks: { request: lockRequest } });
  vi.stubGlobal("fetch", fetchMock);
  await loadWorker();
});

afterEach(() => vi.unstubAllGlobals());

it("precaches the generated manifest in the shell cache", () => {
  expect(precache.options).toEqual({ cacheName: "marknotes-shell" });
  expect(precache.addToCacheList).toHaveBeenCalledWith(manifest);
  expect(Object.keys(handlers).sort()).toEqual([
    "activate",
    "fetch",
    "install",
    "message",
  ]);
});

describe("install", () => {
  it("refuses to install after Forget this device removed the offline marker", async () => {
    const { done } = lifecycle("install");
    await expect(done).rejects.toThrow(
      "Offline registration was removed by Forget this device.",
    );
    expect(lockRequest).toHaveBeenCalledWith(
      "marknotes:public-cache",
      expect.any(Function),
    );
    expect(match).toHaveBeenCalledWith("/offline-enabled", {
      cacheName: "marknotes-offline-control",
    });
    expect(precache.install).not.toHaveBeenCalled();
  });

  it("precaches inside the public-cache lock when offline use is enabled", async () => {
    const order: string[] = [];
    lockRequest.mockImplementation(
      async (_name: string, work: () => Promise<unknown>) => {
        order.push("locked");
        const result = await work();
        order.push("released");
        return result;
      },
    );
    match.mockResolvedValue(new Response("enabled"));
    precache.install.mockImplementation(async () => {
      order.push("install");
    });
    const { event, done } = lifecycle("install");
    await done;
    expect(precache.install).toHaveBeenCalledWith(event);
    expect(order).toEqual(["locked", "install", "released"]);
  });
});

describe("activate", () => {
  it("activates the precache when the offline marker is present", async () => {
    match.mockResolvedValue(new Response("enabled"));
    const { event, done } = lifecycle("activate");
    await done;
    expect(precache.activate).toHaveBeenCalledWith(event);
  });

  it("does not clean up or activate caches after the device was forgotten", async () => {
    const { done } = lifecycle("activate");
    await expect(done).resolves.toBeUndefined();
    expect(lockRequest).toHaveBeenCalledWith(
      "marknotes:public-cache",
      expect.any(Function),
    );
    expect(precache.activate).not.toHaveBeenCalled();
  });
});

describe("message", () => {
  it("skips waiting only for the explicit update request", () => {
    const waitUntil = vi.fn();
    handlers.message!({ data: "PING", waitUntil });
    expect(skipWaiting).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    handlers.message!({ data: "ACTIVATE_UPDATE", waitUntil });
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(skipWaiting.mock.results[0]!.value);
  });
});

describe("fetch", () => {
  it.each([
    ["non-GET requests", `${ORIGIN}/index.html`, "POST"],
    ["cross-origin requests", "https://api.dropboxapi.com/2/files", "GET"],
    ["URLs with a query (OAuth responses)", `${ORIGIN}/?code=secret`, "GET"],
  ])("ignores %s", (_label, url, method) => {
    precache.getCacheKeyForURL.mockReturnValue("/index.html?__WB_REVISION__=1");
    const event = request(url, method);
    expect(precache.getCacheKeyForURL).not.toHaveBeenCalled();
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it("ignores same-origin paths that are not precached", () => {
    const event = request(`${ORIGIN}/config.json`);
    expect(precache.getCacheKeyForURL).toHaveBeenCalledWith("/config.json");
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
  });

  it.each([
    ["/", "/index.html"],
    ["/security", "/security.html"],
    ["/assets/app.js", "/assets/app.js"],
  ])("maps %s to the precached %s", (path, cached) => {
    request(`${ORIGIN}${path}`);
    expect(precache.getCacheKeyForURL).toHaveBeenCalledWith(cached);
  });

  it("serves the cached shell without touching the network", async () => {
    const cached = new Response("shell");
    precache.getCacheKeyForURL.mockReturnValue("/index.html?rev=1");
    match.mockResolvedValue(cached);
    const event = request(`${ORIGIN}/`);
    expect(event.respondWith).toHaveBeenCalledOnce();
    await expect(event.respondWith.mock.calls[0]![0]).resolves.toBe(cached);
    expect(match).toHaveBeenCalledWith("/index.html?rev=1", {
      cacheName: "marknotes-shell",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the network when the precache entry is missing", async () => {
    precache.getCacheKeyForURL.mockReturnValue("/security.html?rev=2");
    const event = request(`${ORIGIN}/security`);
    const response = (await event.respondWith.mock.calls[0]![0]) as Response;
    expect(await response.text()).toBe("network");
    expect(fetchMock).toHaveBeenCalledWith(event.request);
  });
});
