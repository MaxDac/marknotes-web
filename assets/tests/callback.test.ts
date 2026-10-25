// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  broadcastResponseToMainFrame: vi.fn<() => Promise<void>>(),
}));
vi.mock("@azure/msal-browser/redirect-bridge", () => bridge);

async function load(url: string, opener: unknown) {
  history.replaceState(null, "", url);
  vi.stubGlobal("opener", opener);
  vi.resetModules();
  await import("../js/callback");
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("OAuth callback page", () => {
  it("posts the Dropbox code and state to the opener on this origin only, then strips them from the URL", async () => {
    const postMessage = vi.fn();
    await load("/oauth/dropbox?code=abc&state=xyz", { postMessage });
    expect(postMessage).toHaveBeenCalledWith(
      { provider: "dropbox", code: "abc", state: "xyz", error: null },
      location.origin,
    );
    expect(location.pathname).toBe("/oauth/dropbox");
    expect(location.search).toBe("");
    expect(bridge.broadcastResponseToMainFrame).not.toHaveBeenCalled();
  });

  it("forwards a Dropbox error without a code", async () => {
    const postMessage = vi.fn();
    await load("/oauth/dropbox?error=access_denied&state=xyz", {
      postMessage,
    });
    expect(postMessage).toHaveBeenCalledWith(
      { provider: "dropbox", code: null, state: "xyz", error: "access_denied" },
      location.origin,
    );
  });

  it("explains how to sign in when opened without a MarkNotes tab", async () => {
    await load("/oauth/dropbox?code=abc&state=xyz", null);
    expect(document.body.textContent).toContain(
      "Open Dropbox sign-in from MarkNotes in the original tab",
    );
    expect(location.search).toBe("");
  });

  it("hands OneDrive responses to MSAL's redirect bridge", async () => {
    bridge.broadcastResponseToMainFrame.mockResolvedValue();
    const postMessage = vi.fn();
    await load("/oauth/onedrive#code=abc&state=xyz", { postMessage });
    expect(bridge.broadcastResponseToMainFrame).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });

  it("tells the user to reconnect when the OneDrive bridge fails", async () => {
    bridge.broadcastResponseToMainFrame.mockRejectedValue(
      new Error("no opener"),
    );
    await load("/oauth/onedrive#error=x", null);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Microsoft sign-in could not complete",
      ),
    );
  });
});
