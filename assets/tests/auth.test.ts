// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth, pkce, request } from "../js/auth";
import { Store, Vault, type Account } from "../js/storage";
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { syncFailure } from "../js/sync-errors";
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  login: vi.fn(),
  silent: vi.fn(),
  sso: vi.fn(),
  account: vi.fn(),
}));
vi.mock("@azure/msal-browser", () => ({
  BrowserCacheLocation: { MemoryStorage: "memoryStorage" },
  InteractionRequiredAuthError: class extends Error {},
  PublicClientApplication: class {
    constructor(config: unknown) {
      mocks.config(config);
    }
    initialize = async () => {};
    loginPopup = mocks.login;
    acquireTokenSilent = mocks.silent;
    ssoSilent = mocks.sso;
    getAccount = mocks.account;
  },
}));
let store: Store;
const account: Account = {
  id: "db",
  subject: "db-user",
  label: "user",
  provider: "dropbox",
  folder: "MarkNotes",
};
beforeEach(async () => {
  vi.clearAllMocks();
  store = await Store.open(crypto.randomUUID());
});
afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("browser authentication", () => {
  it("generates random S256 PKCE verifier/challenge and state", async () => {
    const a = await pkce(),
      b = await pkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(a.verifier),
    );
    expect(a.challenge).toBe(Buffer.from(digest).toString("base64url"));
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
  it("uses exact MSAL scopes/common authority and memory-only cache", async () => {
    mocks.login.mockResolvedValue({
      accessToken: "private",
      expiresOn: new Date(Date.now() + 3600000),
      account: { username: "user@example.invalid", homeAccountId: "home" },
    });
    const auth = new Auth(store, { dropbox: "", onedrive: "public-client" });
    const result = await auth.connect("onedrive");
    expect(mocks.config).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          authority: "https://login.microsoftonline.com/common",
          redirectUri: `${location.origin}/oauth/onedrive`,
        }),
        cache: { cacheLocation: "memoryStorage" },
      }),
    );
    expect(mocks.login).toHaveBeenCalledWith({
      scopes: ["Files.ReadWrite", "User.Read"],
      prompt: "select_account",
    });
    expect(await new Vault(store).load(result.id)).toEqual(
      expect.objectContaining({ access: "private" }),
    );
  });
  it("rotates Dropbox refresh tokens directly in the browser", async () => {
    await new Vault(store).save(account.id, {
      access: "expired",
      refresh: "old-refresh",
      expires: 0,
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "renewed",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const auth = new Auth(store, { dropbox: "public-key", onedrive: "" });
    expect(await auth.token(account)).toBe("renewed");
    expect(String(fetch.mock.calls[0][1].body)).toContain(
      "grant_type=refresh_token",
    );
    expect(await new Vault(store).load(account.id)).toEqual(
      expect.objectContaining({ refresh: "new-refresh" }),
    );
  });
  it("fails visibly rather than inventing credentials", async () => {
    const auth = new Auth(store, { dropbox: "", onedrive: "" });
    await expect(auth.connect("onedrive")).rejects.toThrow("not configured");
    await expect(auth.token(account)).rejects.toThrow("Reconnect");
  });
  it("bounds Retry-After and omits cookies", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("", { status: 429, headers: { "Retry-After": "120" } }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(request("https://api.dropboxapi.com/test")).rejects.toThrow(
      "rate limiting",
    );
    expect(fetch.mock.calls[0][1].credentials).toBe("omit");
  });
  it("preserves typed network failures without retrying unknown failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(
      request("https://api.dropboxapi.com/test"),
    ).rejects.toMatchObject({
      failure: { kind: "transient" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("invalid input")),
    );
    await expect(request("https://api.dropboxapi.com/test")).rejects.toThrow(
      "invalid input",
    );
  });
  it("caps HTTP retries and preserves the final Retry-After cooldown", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response("", { status: 429, headers: { "Retry-After": "10" } }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = request("https://api.dropboxapi.com/test").catch(
      syncFailure,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual({
      kind: "transient",
      retryAt: Date.now() + 10_000,
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("treats revoked refresh grants and interactive MSAL renewal as explicit reconnects", async () => {
    await new Vault(store).save(account.id, {
      access: "expired",
      refresh: "revoked",
      expires: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 400 })),
    );
    const auth = new Auth(store, {
      dropbox: "public-key",
      onedrive: "public-client",
    });
    await expect(auth.token(account)).rejects.toMatchObject({
      failure: { kind: "authentication" },
    });
    mocks.account.mockReturnValue(null);
    mocks.sso.mockRejectedValue(
      new InteractionRequiredAuthError("interaction_required", "Sign in"),
    );
    await expect(
      auth.token({ ...account, provider: "onedrive" }),
    ).rejects.toMatchObject({
      failure: { kind: "authentication" },
    });
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it("revokes the Dropbox session before forgetting its credentials", async () => {
    await new Vault(store).save(account.id, {
      access: "live",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    });
    await store.saveAccount(account);
    const fetch = vi.fn().mockResolvedValue(new Response("null"));
    vi.stubGlobal("fetch", fetch);
    await new Auth(store, { dropbox: "public-key", onedrive: "" }).forget(
      account,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.dropboxapi.com/2/auth/token/revoke");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      headers: { Authorization: "Bearer live" },
    });
    expect(await new Vault(store).load(account.id)).toBeUndefined();
    expect(await store.accounts()).toEqual([]);
  });
  it("renews an expired Dropbox token to revoke it without saving it", async () => {
    await new Vault(store).save(account.id, {
      access: "expired",
      refresh: "refresh",
      expires: 0,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "renewed", expires_in: 3600 }),
        ),
      )
      .mockResolvedValueOnce(new Response("null"));
    vi.stubGlobal("fetch", fetch);
    await new Auth(store, { dropbox: "public-key", onedrive: "" }).forget(
      account,
    );
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.dropboxapi.com/oauth2/token",
    );
    expect(String(fetch.mock.calls[0][1].body)).toContain(
      "refresh_token=refresh",
    );
    expect(fetch.mock.calls[1][0]).toBe(
      "https://api.dropboxapi.com/2/auth/token/revoke",
    );
    expect(fetch.mock.calls[1][1].headers).toEqual({
      Authorization: "Bearer renewed",
    });
    expect(await new Vault(store).load(account.id)).toBeUndefined();
  });
  it("forgets Dropbox credentials even when revoking fails", async () => {
    for (const outcome of [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => Promise.resolve(new Response("", { status: 401 })),
    ]) {
      await new Vault(store).save(account.id, {
        access: "live",
        expires: Date.now() + 3600_000,
      });
      await store.saveAccount(account);
      vi.stubGlobal("fetch", vi.fn().mockImplementation(outcome));
      await expect(
        new Auth(store, { dropbox: "public-key", onedrive: "" }).forget(
          account,
        ),
      ).resolves.toBeUndefined();
      expect(await new Vault(store).load(account.id)).toBeUndefined();
      expect(await store.accounts()).toEqual([]);
    }
  });
  it("keeps OneDrive disconnect a local sign-out", async () => {
    const onedrive: Account = { ...account, provider: "onedrive" };
    await new Vault(store).save(onedrive.id, {
      access: "graph",
      expires: Date.now() + 3600_000,
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await new Auth(store, { dropbox: "", onedrive: "public-client" }).forget(
      onedrive,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await new Vault(store).load(onedrive.id)).toBeUndefined();
  });
});
