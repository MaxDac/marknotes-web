import { driver, type Driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import { type EditorView } from "@codemirror/view";
import { button, element, segmented } from "./components";
import {
  createEditor,
  cycleHeading,
  format,
  preview,
  setEditorEditable,
} from "./editor";
import { demoText } from "./help";
import type { Store } from "./storage";

export const GUIDE_SETTING = "onboarding-handled";
const GUIDE_LOCK = "marknotes:onboarding";

export interface GuideHost {
  root: HTMLElement;
  store: Pick<Store, "value" | "put">;
  available: () => boolean;
  memoryOnly: boolean;
  changed: () => void;
  error: (error: unknown) => void;
}

export function visibleTarget(
  root: HTMLElement,
  selector: string,
): HTMLElement | undefined {
  const target = root.querySelector<HTMLElement>(selector);
  if (!target || target.getClientRects().length === 0) return;
  const bounds = target.getBoundingClientRect();
  if (bounds.right <= 0 || bounds.bottom <= 0) return;
  if (bounds.left >= innerWidth || bounds.top >= innerHeight) return;
  return target;
}

/** A practice editor with no store, note identity, mention or image hooks. */
export function practice(): {
  root: HTMLElement;
  editor: EditorView;
  destroy: () => void;
} {
  const root = element("section", undefined, "guide-practice");
  root.setAttribute("aria-label", "Temporary Markdown practice");
  root.append(
    element("h2", "Demo - changes are not saved"),
    element(
      "p",
      "Try formatting and the views below. Note links, images and imports are explained only; this practice cannot access your notes.",
    ),
  );
  const controls = element("nav", undefined, "guide-practice-controls");
  controls.setAttribute("aria-label", "Practice formatting");
  const panes = element("div", undefined, "guide-practice-panes");
  panes.dataset.view = "split";
  const source = element("div");
  const output = element("article", undefined, "preview");
  output.setAttribute("aria-label", "Practice preview");
  const render = (text: string) => {
    output.innerHTML = preview(text, { resolve: () => false });
  };
  const editor = createEditor(source, render);
  editor.contentDOM.setAttribute("aria-label", "Practice Markdown editor");
  editor.dispatch({ changes: { from: 0, insert: demoText } });
  setEditorEditable(editor, true);
  render(demoText);
  for (const [label, action] of [
    ["Practice bold", () => format(editor, "**")],
    ["Practice italic", () => format(editor, "*")],
    ["Practice heading", () => cycleHeading(editor)],
  ] as const)
    controls.append(button(label, action, { variant: "outline" }));
  controls.append(
    segmented(
      "Practice view",
      [
        { value: "edit", label: "Edit" },
        { value: "split", label: "Split" },
        { value: "preview", label: "Preview" },
      ],
      "split",
      (view) => {
        panes.dataset.view = view;
        source.hidden = view === "preview";
        output.hidden = view === "edit";
      },
    ),
  );
  root.addEventListener(
    "paste",
    (event) => {
      if (event.clipboardData?.types.includes("Files")) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  for (const type of ["drop", "dragover"] as const)
    root.addEventListener(
      type,
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
  output.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) event.preventDefault();
  });
  panes.append(source, output);
  root.append(controls, panes);
  return { root, editor, destroy: () => editor.destroy() };
}

export class FirstAccessGuide {
  private tour?: Driver;
  private demo?: ReturnType<typeof practice>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private release?: () => void;
  private restoring?: () => void;
  private pending = false;
  private writing = false;
  private dismissed = false;
  constructor(private host: GuideHost) {}
  get active(): boolean {
    return this.pending || !!this.tour;
  }
  start(): Promise<void> {
    const attempt = async (): Promise<void> => {
      if (this.stopped || this.dismissed) return;
      await this.launch(false)
        .catch((error: unknown) => {
          this.dismissed = true;
          this.host.error(error);
        })
        .finally(() => {
          if (!this.stopped && !this.dismissed)
            this.timer = setTimeout(() => void attempt(), 1000);
        });
    };
    return attempt();
  }
  replay(): void {
    void this.launch(true).catch((error: unknown) => this.host.error(error));
  }
  private async launch(replay: boolean): Promise<void> {
    if (this.active || this.stopped) return;
    if (!this.host.available()) {
      if (replay)
        throw new Error(
          "Finish the current operation before replaying the guide.",
        );
      return;
    }
    this.pending = true;
    this.host.changed();
    try {
      await navigator.locks.request(
        GUIDE_LOCK,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            if (replay)
              throw new Error("The guide is open in another MarkNotes tab.");
            return;
          }
          if (
            !replay &&
            (await this.host.store.value(GUIDE_SETTING)) === true
          ) {
            this.dismissed = true;
            return;
          }
          if (this.stopped || !this.host.available()) return;
          await new Promise<void>((resolve, reject) => {
            this.release = resolve;
            try {
              this.show();
            } catch (error) {
              this.release = undefined;
              this.tour?.destroy();
              this.cleanup();
              reject(error);
            }
          });
        },
      );
    } finally {
      this.pending = false;
      this.host.changed();
    }
  }
  private show(): void {
    const { root } = this.host;
    const focus = document.activeElement;
    const workspace = root.querySelector<HTMLElement>("#workspace")!;
    const wasInert = workspace.inert;
    const sidebar = root.classList.contains("sidebar-open");
    const windowScroll = { x: scrollX, y: scrollY };
    const scrolls = [
      ...root.querySelectorAll<HTMLElement>(
        ".sidebar, .tree, .editor-pane, .cm-scroller, #preview",
      ),
    ].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    const restoreScroll = () => {
      for (const { node, top, left } of scrolls) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
      window.scrollTo(windowScroll.x, windowScroll.y);
    };
    root.classList.add("guide-active");
    workspace.inert = true;
    const center = element("span", undefined, "guide-center");
    center.setAttribute("aria-hidden", "true");
    document.body.append(center);
    const restoreSidebar = () => {
      root.classList.toggle("sidebar-open", sidebar);
    };
    const resize = () => this.tour?.refresh();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.finish();
      }
      if (event.key !== "Tab") return;
      const scopes = [
        document.querySelector<HTMLElement>(".driver-popover"),
        this.demo?.root,
      ];
      const controls = scopes.flatMap((scope) =>
        scope
          ? [
              ...scope.querySelectorAll<HTMLElement>(
                'button:not(:disabled), [href], [tabindex="0"], [contenteditable="true"]',
              ),
            ].filter(
              (node) => node.tabIndex >= 0 && node.getClientRects().length > 0,
            )
          : [],
      );
      if (!controls.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[
        (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
      ].focus();
    };
    const focusGuard = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest(".driver-popover, .guide-practice")
      )
        document.querySelector<HTMLElement>(".driver-popover button")?.focus();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focusGuard);
    const blockDrop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("dragover", blockDrop, true);
    document.addEventListener("drop", blockDrop, true);
    window.addEventListener("resize", resize);
    const visibility = () => {
      if (document.visibilityState !== "visible") {
        this.tour?.destroy();
        this.cleanup();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    this.restoring = () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focusGuard);
      document.removeEventListener("dragover", blockDrop, true);
      document.removeEventListener("drop", blockDrop, true);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
      workspace.inert = wasInert;
      root.classList.remove("guide-active");
      center.remove();
      restoreSidebar();
      if (focus instanceof HTMLElement && focus.isConnected)
        focus.focus({ preventScroll: true });
      restoreScroll();
      queueMicrotask(restoreScroll);
    };
    this.demo = practice();
    this.demo.root.id = "onboarding-practice";
    this.demo.root.hidden = true;
    document.body.append(this.demo.root);
    const hideDemo = () => {
      if (this.demo) this.demo.root.hidden = true;
    };
    const step = (
      selector: string | undefined,
      title: string,
      description: string,
      sidebarStep = false,
    ): DriveStep => ({
      ...(selector
        ? {
            element: () => {
              root.classList.toggle("sidebar-open", sidebarStep || sidebar);
              return visibleTarget(root, selector) || center;
            },
          }
        : {}),
      popover: { title, description },
      onHighlightStarted: () => {
        hideDemo();
        root.classList.toggle("sidebar-open", sidebarStep || sidebar);
      },
    });
    const steps: DriveStep[] = [
      step(
        undefined,
        "Your notes, in your browser",
        "Notes autosave locally; saving is not drive sync. Offline launch works after MarkNotes reports it is ready offline. Sign-in and sync need a connection." +
          (this.host.memoryOnly
            ? " Memory-only mode forgets notes and this guide preference when the session closes. The guide can appear each session."
            : " Skip or Finish remembers this guide in this browser profile. Replay it any time from Help."),
      ),
      step(
        "#new",
        "Create, organize or import",
        "New creates notes and folders, or imports documents with a preview before saving. The sidebar shows your folders and notes. Imports are converted locally. Nothing in this guide creates a real note.",
        true,
      ),
      {
        element: () => {
          this.demo!.root.hidden = false;
          return this.demo!.root;
        },
        disableActiveInteraction: false,
        popover: {
          title: "Try Markdown",
          description:
            "Type here and try formatting, Edit, Split and Preview. Your actual note, selection and undo history stay unchanged.",
          side: "top",
        },
        onHighlightStarted: () => {
          restoreSidebar();
        },
      },
      step(
        "#connect",
        "Optional drive sync",
        "Connect an available Dropbox or OneDrive account to choose a notes folder. Not configured means this deployment cannot connect that provider. Sync now saves first and then syncs directly with your drives. Local autosave alone does not upload notes; reconnect sync is optional in Settings.",
        true,
      ),
      step(
        "#help",
        "Help is always here",
        "Replay this guide or open What is Markdown? for examples and this app's actual coverage and limits. Settings controls appearance, storage privacy and optional chord sequences. Chords are a separate editor, not a Markdown extension.",
      ),
    ];
    this.tour = driver({
      steps,
      animate: !matchMedia("(prefers-reduced-motion: reduce)").matches,
      smoothScroll: false,
      allowKeyboardControl: false,
      allowClose: true,
      overlayClickBehavior: () => void this.finish(),
      disableActiveInteraction: true,
      showProgress: true,
      progressText: "{{current}} of {{total}}",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Finish",
      popoverClass: "marknotes-guide",
      onCloseClick: () => void this.finish(),
      onNextClick: () => {
        if (this.tour?.isLastStep()) void this.finish();
        else this.tour?.moveNext();
      },
      onPrevClick: () => this.tour?.movePrevious(),
      onPopoverRender: (popover) => {
        popover.closeButton.textContent = "Skip";
        popover.closeButton.setAttribute("aria-label", "Skip guide");
        popover.progress.setAttribute("aria-live", "polite");
        if (this.demo && !this.demo.root.hidden)
          popover.wrapper.setAttribute("aria-controls", this.demo.root.id);
      },
      onDestroyed: () => this.cleanup(),
    });
    this.host.changed();
    this.tour.drive();
  }
  private async finish(): Promise<void> {
    if (this.writing || !this.tour) return;
    this.writing = true;
    try {
      await this.host.store.put(GUIDE_SETTING, true);
      this.dismissed = true;
      this.tour?.destroy();
      this.cleanup();
    } catch (error) {
      this.host.error(error);
      const popover = document.querySelector(".driver-popover");
      if (popover) {
        let alert = popover.querySelector<HTMLElement>("[role=alert]");
        if (!alert) {
          alert = element("p");
          alert.setAttribute("role", "alert");
          popover.append(alert);
        }
        alert.textContent =
          "Could not remember your choice. Try Skip or Finish again.";
      }
    } finally {
      this.writing = false;
    }
  }
  private cleanup(): void {
    if (!this.tour && !this.demo && !this.restoring && !this.release) return;
    this.tour = undefined;
    this.demo?.destroy();
    this.demo?.root.remove();
    this.demo = undefined;
    this.restoring?.();
    this.restoring = undefined;
    this.release?.();
    this.release = undefined;
    this.host.changed();
  }
  destroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.tour?.destroy();
    this.cleanup();
  }
}
