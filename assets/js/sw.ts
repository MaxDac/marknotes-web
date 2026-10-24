/// <reference lib="webworker" />
import { PrecacheController } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

const SHELL_CACHE = "marknotes-shell";
const cache = new PrecacheController({ cacheName: SHELL_CACHE });
cache.addToCacheList(self.__WB_MANIFEST);

// All writes finish under the same lock used by registration and device deletion.
// Fetch only reads the precache, so an old controller cannot repopulate a forgotten cache.
self.addEventListener("install", (event) => {
  event.waitUntil(
    navigator.locks.request("marknotes:public-cache", async () => {
      if (
        !(await caches.match("/offline-enabled", {
          cacheName: "marknotes-offline-control",
        }))
      )
        throw new Error(
          "Offline registration was removed by Forget this device.",
        );
      return cache.install(event);
    }),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    navigator.locks.request("marknotes:public-cache", async () => {
      if (
        await caches.match("/offline-enabled", {
          cacheName: "marknotes-offline-control",
        })
      )
        await cache.activate(event);
    }),
  );
});
self.addEventListener("message", (event) => {
  if (event.data === "ACTIVATE_UPDATE") event.waitUntil(self.skipWaiting());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search
  )
    return;
  const path =
    url.pathname === "/"
      ? "/index.html"
      : url.pathname === "/security"
        ? "/security.html"
        : url.pathname;
  const key = cache.getCacheKeyForURL(path);
  if (!key) return;
  event.respondWith(
    caches
      .match(key, { cacheName: SHELL_CACHE })
      .then((cached) => cached ?? fetch(event.request)),
  );
});
