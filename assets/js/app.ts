import { Socket } from "phoenix";
import { LiveSocket } from "phoenix_live_view";
import { NotesUI } from "./ui";
import "../css/app.css";

interface NotesHook {
  el: HTMLElement;
  ui?: NotesUI;
}
const Notes = {
  mounted(this: NotesHook) {
    this.ui = new NotesUI(this.el, {
      dropbox: this.el.dataset.dropbox ?? "",
      onedrive: this.el.dataset.onedrive ?? "",
    });
    void this.ui.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const alert = document.createElement("p");
      alert.setAttribute("role", "alert");
      alert.textContent = `MarkNotes could not initialize: ${message}`;
      this.el.append(alert);
    });
  },
  disconnected(this: NotesHook) {
    this.ui?.connection(false);
  },
  reconnected(this: NotesHook) {
    this.ui?.connection(true);
  },
  destroyed(this: NotesHook) {
    this.ui?.destroy();
  },
};
const socket = new LiveSocket("/live", Socket, {
  params: {
    _csrf_token: document.querySelector<HTMLMetaElement>(
      "meta[name=csrf-token]",
    )?.content,
  },
  hooks: { Notes },
});
socket.connect();
