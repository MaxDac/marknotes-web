import { NotesUI } from "./ui";
import { loadConfig } from "./config";
import { startPwa, pwaStatus } from "./pwa";
import "../css/app.css";

const root = document.querySelector<HTMLElement>("#marknotes")!;
window.addEventListener("marknotes:pwa-error", (event) =>
  pwaStatus(String((event as CustomEvent<unknown>).detail)),
);
void (async () => {
  const ui = new NotesUI(root, await loadConfig());
  void startPwa(() => ui.prepareUpdate());
  await ui.start();
})().catch((error: unknown) => {
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent = `MarkNotes could not initialize: ${error instanceof Error ? error.message : String(error)}`;
  root.append(alert);
});
