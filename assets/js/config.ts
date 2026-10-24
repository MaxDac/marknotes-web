import { type PublicConfig } from "./auth";

export const PUBLIC_CACHE_LOCK = "marknotes:public-cache";
const CONFIG_CACHE = "marknotes-public-config-v1";
export let publicConfigCached = false;
export let deviceForgotten = false;
const channel =
  typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("marknotes:offline")
    : undefined;
if (channel) {
  channel.addEventListener("message", () => {
    deviceForgotten = true;
  });
}
export function disablePublicCache(): void {
  deviceForgotten = true;
  channel?.postMessage("forget");
}

export function validateConfig(value: unknown): PublicConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("dropbox" in value) ||
    typeof value.dropbox !== "string" ||
    !("onedrive" in value) ||
    typeof value.onedrive !== "string"
  )
    throw new Error(
      "Invalid public configuration. Reload online or contact the site operator.",
    );
  return { dropbox: value.dropbox.trim(), onedrive: value.onedrive.trim() };
}

export async function loadConfig(): Promise<PublicConfig> {
  let response: Response;
  try {
    response = await fetch("/config.json", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (typeof caches !== "undefined") {
      const cached = await caches.match("/config.json", {
        cacheName: CONFIG_CACHE,
      });
      if (cached) {
        const config = validateConfig(await cached.json());
        publicConfigCached = true;
        return config;
      }
    }
    throw new Error(
      "Public configuration is unavailable. Open MarkNotes online before using it offline.",
      { cause: error },
    );
  }
  if (!response.ok)
    throw new Error(
      `Public configuration request failed (${response.status}).`,
    );
  const value: unknown = await response.json();
  const config = validateConfig(value);
  if (typeof caches !== "undefined") {
    try {
      await navigator.locks.request(PUBLIC_CACHE_LOCK, async () => {
        if (deviceForgotten) return;
        const cache = await caches.open(CONFIG_CACHE);
        await cache.put(
          "/config.json",
          new Response(JSON.stringify({ schema: 1, ...config })),
        );
        publicConfigCached = true;
      });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("marknotes:pwa-error", {
          detail: `Offline configuration could not be saved: ${String(error)}`,
        }),
      );
    }
  }
  return config;
}
