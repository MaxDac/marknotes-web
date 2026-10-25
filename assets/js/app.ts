import { NotesUI } from "./ui";
import { loadConfig } from "./config";
import { startPwa, pwaStatus } from "./pwa";
import "../css/app.css";

const root = document.querySelector<HTMLElement>("#marknotes")!;
let ui: NotesUI | undefined;
window.addEventListener("marknotes:pwa-error", (event) =>
  pwaStatus(String((event as CustomEvent<unknown>).detail)),
);
void (async () => {
  ui = new NotesUI(root, await loadConfig());
  const current = ui;
  void startPwa(() => current.prepareUpdate());
  await ui.start();
})().catch((error: unknown) => {
  ui?.recordDiagnostic("initialization-failed");
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent = `MarkNotes could not initialize: ${error instanceof Error ? error.message : String(error)}`;
  root.append(alert);
});
