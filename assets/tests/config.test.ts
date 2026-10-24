import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, validateConfig } from "../js/config";

afterEach(() => vi.unstubAllGlobals());

describe("public configuration", () => {
  it("retains blank disabled IDs", () => {
    const config = validateConfig({
      schema: 1,
      dropbox: " key ",
      onedrive: "",
    });
    expect(config).toEqual({ dropbox: "key", onedrive: "" });
  });
  it.each([
    null,
    {},
    { schema: 2, dropbox: "key", onedrive: "id" },
    { schema: 1, dropbox: 1, onedrive: "" },
  ])("rejects invalid configuration %j", (value) => {
    expect(() => validateConfig(value)).toThrow("Invalid public configuration");
  });
});

describe("configuration loading", () => {
  it("uses the last valid config when the network is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const cached = Response.json({
      schema: 1,
      dropbox: "cached",
      onedrive: "",
    });
    vi.stubGlobal("caches", { match: vi.fn().mockResolvedValue(cached) });
    await expect(loadConfig()).resolves.toEqual({
      dropbox: "cached",
      onedrive: "",
    });
  });
  it("does not hide online errors with cached defaults", async () => {
    const response = new Response("", { status: 503 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const match = vi.fn();
    vi.stubGlobal("caches", { match });
    await expect(loadConfig()).rejects.toThrow("(503)");
    expect(match).not.toHaveBeenCalled();
  });
  it("caches only allowlisted public keys", async () => {
    const response = Response.json({
      schema: 1,
      dropbox: " public ",
      onedrive: "",
      ignored: "not-public",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue({ put }) });
    await loadConfig();
    const cached = put.mock.calls[0][1] as Response;
    expect(await cached.json()).toEqual({
      schema: 1,
      dropbox: "public",
      onedrive: "",
    });
  });
});
