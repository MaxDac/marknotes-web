import { afterEach, expect, it, vi } from "vitest";
import { clearOfflineApp } from "../js/pwa";

afterEach(() => vi.unstubAllGlobals());

it("unregisters the app worker and clears caches inside the public-cache lock", async () => {
  const order: string[] = [];
  vi.stubGlobal("location", { origin: "https://notes.example" });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (name: string, work: () => Promise<void>) => {
        order.push(name);
        await work();
        order.push("released");
      },
    },
    serviceWorker: {
      getRegistrations: async () => [
        {
          scope: "https://notes.example/",
          unregister: async () => {
            order.push("unregistered");
            return true;
          },
        },
      ],
    },
  });
  vi.stubGlobal("caches", {
    keys: async () => [
      "marknotes-shell",
      "marknotes-public-config-v1",
      "marknotes-offline-control",
    ],
    delete: async (key: string) => {
      order.push(key);
      return true;
    },
  });
  await clearOfflineApp();
  expect(order).toEqual([
    "marknotes:public-cache",
    "unregistered",
    "marknotes-shell",
    "marknotes-public-config-v1",
    "marknotes-offline-control",
    "released",
  ]);
});
