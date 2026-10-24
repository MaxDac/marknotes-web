import {
  PUBLIC_CACHE_LOCK,
  deviceForgotten,
  disablePublicCache,
  publicConfigCached,
} from "./config";

export function pwaStatus(text: string, action?: () => Promise<void>): void {
  const root = document.querySelector("#pwa-status");
  if (!root) return;
  const message = document.createElement("p");
  message.textContent = text;
  root.replaceChildren(message);
  if (action) {
    const button = document.createElement("button");
    button.textContent = "Save and update";
    button.className = "btn btn-outline";
    button.addEventListener("click", () => {
      button.disabled = true;
      void action().catch((error: unknown) => {
        pwaStatus(
          `Update postponed: ${error instanceof Error ? error.message : String(error)}`,
          action,
        );
      });
    });
    root.append(button);
  }
}

export async function startPwa(
  prepare: () => Promise<() => void>,
): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    pwaStatus(
      "Offline launch is unavailable in this browser. Online editing still works.",
    );
    return;
  }
  try {
    if (!publicConfigCached)
      throw new Error("The public configuration could not be cached.");
    const registration = await navigator.locks.request(
      PUBLIC_CACHE_LOCK,
      async () => {
        if (deviceForgotten)
          throw new Error(
            "This device was forgotten. Reopen online to prepare offline use.",
          );
        const control = await caches.open("marknotes-offline-control");
        await control.put("/offline-enabled", new Response("enabled"));
        return navigator.serviceWorker.register("/sw.js", {
          type: "module",
          updateViaCache: "none",
        });
      },
    );
    const offer = () => {
      if (!registration.waiting) return;
      pwaStatus(
        "A MarkNotes update is ready. Save your work before updating.",
        async () => {
          const worker = registration.waiting;
          if (!worker)
            throw new Error(
              "The update is no longer available. Reload online to check again.",
            );
          const resume = await prepare();
          let changed: (() => void) | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const activated = new Promise<void>((resolve, reject) => {
              changed = resolve;
              navigator.serviceWorker.addEventListener(
                "controllerchange",
                changed,
                { once: true },
              );
              timer = setTimeout(
                () =>
                  reject(
                    new Error("Update activation timed out. Try again online."),
                  ),
                15_000,
              );
            });
            worker.postMessage("ACTIVATE_UPDATE");
            await activated;
            location.reload();
          } catch (error) {
            resume();
            throw error;
          } finally {
            clearTimeout(timer);
            if (changed)
              navigator.serviceWorker.removeEventListener(
                "controllerchange",
                changed,
              );
          }
        },
      );
    };
    const track = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const changed = () => {
        if (worker.state === "installed") {
          if (registration.active || navigator.serviceWorker.controller)
            offer();
          else pwaStatus("MarkNotes is ready offline.");
        } else if (worker.state === "redundant") {
          pwaStatus(
            "Offline preparation failed. Keep this tab open and retry online.",
          );
        }
      };
      worker.addEventListener("statechange", changed);
      changed();
    };
    registration.addEventListener("updatefound", () =>
      track(registration.installing),
    );
    track(registration.installing);
    if (registration.waiting && registration.active) offer();
    else if (registration.active) pwaStatus("MarkNotes is ready offline.");
  } catch (error) {
    pwaStatus(
      `Offline preparation failed: ${error instanceof Error ? error.message : String(error)}. Online editing still works.`,
    );
  }
}

export async function clearOfflineApp(): Promise<void> {
  disablePublicCache();
  await navigator.locks.request(PUBLIC_CACHE_LOCK, async () => {
    if ("serviceWorker" in navigator) {
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        if (registration.scope !== `${location.origin}/`) continue;
        await registration.unregister();
      }
    }
    if (typeof caches !== "undefined")
      for (const key of await caches.keys()) await caches.delete(key);
  });
}
