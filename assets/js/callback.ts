import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

if (location.pathname === "/oauth/onedrive") {
  // MSAL's redirect bridge handles its own state and popup/iframe channel.
  void broadcastResponseToMainFrame().catch(() => {
    document.body.textContent =
      "Microsoft sign-in could not complete. Close this window and reconnect from MarkNotes.";
  });
} else {
  const params = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  if (window.opener) {
    window.opener.postMessage(
      {
        provider: "dropbox",
        code: params.get("code"),
        state: params.get("state"),
        error: params.get("error"),
      },
      location.origin,
    );
  } else {
    document.body.textContent =
      "Open Dropbox sign-in from MarkNotes in the original tab, with popups allowed.";
  }
}
