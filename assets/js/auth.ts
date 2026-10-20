import {
  PublicClientApplication,
  BrowserCacheLocation,
  InteractionRequiredAuthError,
} from "@azure/msal-browser";
import { Store, Vault, type Account } from "./storage";

export interface PublicConfig {
  dropbox: string;
  onedrive: string;
}
interface Tokens {
  access: string;
  refresh?: string;
  expires: number;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    provider: string,
  ) {
    super(
      `${provider} request failed (${status}). ${status === 401 ? "Reconnect this account." : status === 409 || status === 412 ? "Remote data changed; sync again." : "Please retry."}`,
    );
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function request(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(60_000),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if ((response.status === 429 || response.status === 503) && attempt < 3) {
      const retry = response.headers.get("retry-after");
      const seconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry)
          : retry
            ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000)
            : 2 ** attempt;
      if (!Number.isFinite(seconds) || seconds > 60)
        throw new Error("Provider is rate limiting requests; try sync later.");
      await delay(seconds * 1000);
      continue;
    }
    return response;
  }
}
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function pkce(): Promise<{
  verifier: string;
  challenge: string;
  state: string;
}> {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  return {
    verifier,
    challenge: b64(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
    state: b64(crypto.getRandomValues(new Uint8Array(32))),
  };
}
export class Auth {
  private msal?: PublicClientApplication;
  private vault: Vault;
  constructor(
    private store: Store,
    readonly config: PublicConfig,
  ) {
    this.vault = new Vault(store);
  }
  private async microsoft(): Promise<PublicClientApplication> {
    if (!this.config.onedrive) throw new Error("OneDrive is not configured.");
    if (!this.msal) {
      this.msal = new PublicClientApplication({
        auth: {
          clientId: this.config.onedrive,
          authority: "https://login.microsoftonline.com/common",
          redirectUri: `${location.origin}/oauth/onedrive`,
        },
        cache: { cacheLocation: BrowserCacheLocation.MemoryStorage },
      });
      await this.msal.initialize();
    }
    return this.msal;
  }
  async connect(provider: Account["provider"]): Promise<Account> {
    const id = `${provider}-${crypto.randomUUID()}`;
    if (provider === "onedrive") {
      const app = await this.microsoft();
      const result = await app.loginPopup({
        scopes: ["Files.ReadWrite", "User.Read"],
        prompt: "select_account",
      });
      await this.vault.save(id, {
        access: result.accessToken,
        expires: result.expiresOn?.getTime() ?? Date.now(),
      } satisfies Tokens);
      return {
        id,
        provider,
        label: result.account.username,
        subject: result.account.homeAccountId,
        folder: "MarkNotes",
      };
    }
    if (!this.config.dropbox) throw new Error("Dropbox is not configured.");
    const popup = window.open(
      "about:blank",
      "marknotes-dropbox",
      "width=600,height=760",
    );
    if (!popup) throw new Error("Allow popups to connect Dropbox.");
    const p = await pkce();
    const redirect = `${location.origin}/oauth/dropbox`;
    const params = new URLSearchParams({
      client_id: this.config.dropbox,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: p.challenge,
      state: p.state,
      redirect_uri: redirect,
      token_access_type: "offline",
      scope:
        "account_info.read files.metadata.read files.content.read files.content.write",
    });
    const code = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearInterval(timer);
        window.removeEventListener("message", listener);
        popup.close();
      };
      const deadline = Date.now() + 5 * 60_000;
      const listener = (event: MessageEvent<unknown>) => {
        if (
          event.origin !== location.origin ||
          event.source !== popup ||
          typeof event.data !== "object" ||
          event.data === null
        )
          return;
        const data = event.data as {
          provider?: string;
          state?: string;
          code?: string;
          error?: string;
        };
        if (data.provider !== "dropbox") return;
        cleanup();
        if (data.state !== p.state)
          reject(
            new Error("Dropbox sign-in state did not match. Please reconnect."),
          );
        else if (data.error || !data.code)
          reject(new Error("Dropbox sign-in was declined or failed."));
        else resolve(data.code);
      };
      const timer = setInterval(() => {
        if (popup.closed || Date.now() > deadline) {
          cleanup();
          reject(new Error("Dropbox sign-in was cancelled or timed out."));
        }
      }, 500);
      window.addEventListener("message", listener);
      popup.location.href = `https://www.dropbox.com/oauth2/authorize?${params}`;
    });
    const tokens = await this.dropboxToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        redirect_uri: redirect,
        client_id: this.config.dropbox,
      }),
    );
    await this.vault.save(id, tokens);
    const response = await request(
      "https://api.dropboxapi.com/2/users/get_current_account",
      { method: "POST", headers: { Authorization: `Bearer ${tokens.access}` } },
    );
    if (!response.ok) throw new ApiError(response.status, "Dropbox");
    const account = (await response.json()) as {
      email: string;
      account_id: string;
    };
    return {
      id,
      provider,
      label: account.email,
      subject: account.account_id,
      folder: "MarkNotes",
    };
  }
  private async dropboxToken(body: URLSearchParams): Promise<Tokens> {
    const response = await request("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      body,
    });
    if (!response.ok)
      throw new ApiError(response.status, "Dropbox authentication");
    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!data.access_token || !Number.isFinite(data.expires_in))
      throw new Error("Dropbox returned an invalid token response.");
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000,
    };
  }
  async token(account: Account, force = false): Promise<string> {
    const saved = await this.vault.load<Tokens>(account.id);
    if (!force && saved && saved.expires > Date.now() + 60_000)
      return saved.access;
    if (account.provider === "dropbox") {
      if (!saved?.refresh)
        throw new Error("Reconnect Dropbox to renew this session.");
      const renewed = await this.dropboxToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: saved.refresh,
          client_id: this.config.dropbox,
        }),
      );
      await this.vault.save(account.id, {
        ...renewed,
        refresh: renewed.refresh ?? saved.refresh,
      });
      return renewed.access;
    }
    const app = await this.microsoft(),
      cached = app.getAccount({ homeAccountId: account.subject });
    try {
      const result = cached
        ? await app.acquireTokenSilent({
            scopes: ["Files.ReadWrite", "User.Read"],
            account: cached,
            forceRefresh: force,
          })
        : await app.ssoSilent({
            scopes: ["Files.ReadWrite", "User.Read"],
            loginHint: account.label,
          });
      if (result.account.homeAccountId !== account.subject)
        throw new Error(
          "Microsoft returned a different account; reconnect the intended account.",
        );
      await this.vault.save(account.id, {
        access: result.accessToken,
        expires: result.expiresOn?.getTime() ?? Date.now(),
      } satisfies Tokens);
      return result.accessToken;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError)
        throw new Error(
          "Reconnect OneDrive: Microsoft requires interactive sign-in.",
        );
      throw error;
    }
  }
  async authorized(
    account: Account,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const send = async (force: boolean) =>
      request(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${await this.token(account, force)}`,
        },
      });
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    return response;
  }
  async forget(account: Account): Promise<void> {
    if (account.provider === "onedrive" && this.msal) {
      const cached = this.msal.getAccount({ homeAccountId: account.subject });
      if (cached) await this.msal.clearCache({ account: cached });
    }
    await this.store.forgetAccount(account.id);
  }
}
