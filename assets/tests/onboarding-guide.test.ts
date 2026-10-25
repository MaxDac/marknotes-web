// @vitest-environment jsdom
import type { Config, DriveStep, PopoverDOM } from "driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FirstAccessGuide,
  GUIDE_SETTING,
  type GuideHost,
  practice,
  visibleTarget,
} from "../js/onboarding";

const driverMock = vi.hoisted(() => {
  class FakeTour {
    index = 0;
    target?: Element;
    popover?: HTMLElement;
    destroyed = false;
    refresh = vi.fn();
    constructor(public config: Config) {}
    get steps(): DriveStep[] {
      return this.config.steps!;
    }
    get step(): DriveStep {
      return this.steps[this.index]!;
    }
    private opts(): never {
      return {
        config: this.config,
        state: {},
        driver: this,
        index: this.index,
      } as never;
    }
    drive(): void {
      if (driverMock.failDrive) throw new Error("Tour failed to render");
      this.render();
    }
    private render(): void {
      const step = this.step;
      step.onHighlightStarted?.(undefined, step, this.opts());
      const element = step.element;
      this.target =
        typeof element === "function"
          ? element()
          : typeof element === "string"
            ? (document.querySelector(element) ?? undefined)
            : element;
      this.popover?.remove();
      const make = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        text = "",
      ) => {
        const node = document.createElement(tag);
        node.textContent = text;
        return node;
      };
      const wrapper = make("div");
      wrapper.className = "driver-popover";
      const dom: PopoverDOM = {
        wrapper,
        arrow: make("div"),
        title: make("h2", step.popover?.title),
        description: make("div", step.popover?.description),
        footer: make("footer"),
        progress: make("span", `${this.index + 1} of ${this.steps.length}`),
        previousButton: make("button", "Back"),
        nextButton: make("button", "Next"),
        closeButton: make("button", "×"),
        footerButtons: make("span"),
      };
      dom.footerButtons.append(dom.previousButton, dom.nextButton);
      dom.footer.append(dom.progress, dom.footerButtons);
      wrapper.append(dom.closeButton, dom.title, dom.description, dom.footer);
      document.body.append(wrapper);
      this.popover = wrapper;
      this.config.onPopoverRender?.(dom, this.opts());
    }
    isLastStep(): boolean {
      return this.index === this.steps.length - 1;
    }
    moveNext(): void {
      this.index++;
      this.render();
    }
    movePrevious(): void {
      this.index--;
      this.render();
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.popover?.remove();
      this.config.onDestroyed?.(undefined, this.step, this.opts());
    }
    next(): void {
      this.config.onNextClick?.(this.target, this.step, this.opts());
    }
    previous(): void {
      this.config.onPrevClick?.(this.target, this.step, this.opts());
    }
    skip(): void {
      this.config.onCloseClick?.(this.target, this.step, this.opts());
    }
    overlay(): void {
      const behavior = this.config.overlayClickBehavior;
      if (typeof behavior === "function")
        behavior(this.target, this.step, this.opts());
    }
  }
  return { tours: [] as FakeTour[], failDrive: false, FakeTour };
});

vi.mock("driver.js", () => ({
  driver: (config: Config) => {
    const tour = new driverMock.FakeTour(config);
    driverMock.tours.push(tour);
    return tour;
  },
}));

const tours = driverMock.tours;
let lockFree: boolean;
let lockRequest: ReturnType<typeof vi.fn>;
let reducedMotion: boolean;
const guides: FirstAccessGuide[] = [];

beforeEach(() => {
  tours.length = 0;
  driverMock.failDrive = false;
  lockFree = true;
  reducedMotion = false;
  lockRequest = vi.fn(
    async (
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<void>,
    ) => callback(lockFree ? ({ name, mode: "exclusive" } as Lock) : null),
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: lockRequest },
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("reduced-motion") && reducedMotion,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const guide of guides.splice(0)) guide.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
  document.body.replaceChildren();
});

function setup(
  options: {
    handled?: boolean;
    memoryOnly?: boolean;
    sidebar?: boolean;
    workspace?: boolean;
  } = {},
) {
  const root = document.createElement("div");
  root.innerHTML = `
    <aside class="sidebar"><button id="new">New</button><button id="connect">Connect</button></aside>
    ${options.workspace === false ? "" : '<main id="workspace"><button id="help">Help</button><button id="editing">Note</button></main>'}`;
  if (options.sidebar) root.classList.add("sidebar-open");
  document.body.append(root);
  const values = new Map<string, unknown>();
  if (options.handled) values.set(GUIDE_SETTING, true);
  const store = {
    value: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
  const state = { available: true };
  const host = {
    root,
    store,
    available: () => state.available,
    memoryOnly: options.memoryOnly ?? false,
    changed: vi.fn(),
    error: vi.fn(),
  };
  const guide = new FirstAccessGuide(host as unknown as GuideHost);
  guides.push(guide);
  return { root, store, values, state, host, guide };
}

async function shown(count = 1) {
  await vi.waitFor(() => expect(tours).toHaveLength(count));
  return tours[count - 1]!;
}

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(event);
  return event;
}

describe("first-access tour", () => {
  it("walks every step, isolates the workspace and remembers Finish", async () => {
    const { root, store, host, guide } = setup();
    const editing = root.querySelector<HTMLElement>("#editing")!;
    editing.focus();
    const started = guide.start();
    const tour = await shown();
    const workspace = root.querySelector<HTMLElement>("#workspace")!;

    expect(store.value).toHaveBeenCalledWith(GUIDE_SETTING);
    expect(guide.active).toBe(true);
    expect(host.changed).toHaveBeenCalled();
    expect(root.classList.contains("guide-active")).toBe(true);
    expect(workspace.inert).toBe(true);
    const demo = document.querySelector<HTMLElement>("#onboarding-practice")!;
    expect(demo.hidden).toBe(true);
    const center = document.querySelector(".guide-center")!;
    expect(center.getAttribute("aria-hidden")).toBe("true");
    expect(tour.steps).toHaveLength(5);
    expect(tour.target).toBeUndefined();
    const skip = tour.popover!.querySelector("button")!;
    expect(skip.textContent).toBe("Skip");
    expect(skip.getAttribute("aria-label")).toBe("Skip guide");
    expect(tour.popover!.querySelector("span")?.getAttribute("aria-live")).toBe(
      "polite",
    );

    tour.next();
    expect(tour.step.popover?.title).toBe("Create, organize or import");
    expect(root.classList.contains("sidebar-open")).toBe(true);
    expect(tour.target).toBe(center);

    tour.next();
    expect(tour.target).toBe(demo);
    expect(demo.hidden).toBe(false);
    expect(root.classList.contains("sidebar-open")).toBe(false);
    expect(tour.popover!.getAttribute("aria-controls")).toBe(
      "onboarding-practice",
    );

    tour.previous();
    expect(tour.index).toBe(1);
    expect(demo.hidden).toBe(true);
    tour.next();
    tour.next();
    expect(tour.step.popover?.title).toBe("Optional drive sync");
    expect(demo.hidden).toBe(true);
    expect(root.classList.contains("sidebar-open")).toBe(true);

    tour.next();
    expect(tour.step.popover?.title).toBe("Help is always here");
    expect(root.classList.contains("sidebar-open")).toBe(false);
    expect(store.put).not.toHaveBeenCalled();

    tour.popover!.querySelectorAll("button")[2]!.focus();
    expect(document.activeElement).not.toBe(editing);
    tour.next();
    await started;
    expect(store.put).toHaveBeenCalledWith(GUIDE_SETTING, true);
    expect(tour.destroyed).toBe(true);
    expect(guide.active).toBe(false);
    expect(root.classList.contains("guide-active")).toBe(false);
    expect(workspace.inert).toBeFalsy();
    expect(document.querySelector("#onboarding-practice")).toBeNull();
    expect(document.querySelector(".guide-center")).toBeNull();
    expect(document.activeElement).toBe(editing);
    expect(host.error).not.toHaveBeenCalled();
    guide.destroy();
  });

  it("keeps an open sidebar open on non-sidebar steps and after the tour", async () => {
    const { root, guide } = setup({ sidebar: true });
    void guide.start();
    const tour = await shown();
    tour.next();
    tour.next();
    expect(root.classList.contains("sidebar-open")).toBe(true);
    tour.next();
    tour.next();
    expect(root.classList.contains("sidebar-open")).toBe(true);
    guide.destroy();
    expect(root.classList.contains("sidebar-open")).toBe(true);
  });

  it("anchors steps on visible toolbar targets", async () => {
    const { root, guide } = setup();
    const target = root.querySelector<HTMLElement>("#new")!;
    vi.spyOn(target, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 10, 50, 20),
    );
    void guide.start();
    const tour = await shown();
    tour.next();
    expect(tour.target).toBe(target);
    guide.destroy();
  });

  it.each([
    ["Skip", (tour: (typeof tours)[number]) => tour.skip()],
    ["an overlay click", (tour: (typeof tours)[number]) => tour.overlay()],
    [
      "Escape",
      () => {
        const event = key({ key: "Escape" });
        expect(event.defaultPrevented).toBe(true);
      },
    ],
  ])("remembers the choice when closed with %s", async (_label, close) => {
    const { store, guide } = setup();
    const started = guide.start();
    const tour = await shown();
    close(tour);
    await started;
    expect(store.put).toHaveBeenCalledWith(GUIDE_SETTING, true);
    expect(guide.active).toBe(false);
    expect(document.querySelector(".driver-popover")).toBeNull();
  });

  it("explains memory-only persistence in the first step", async () => {
    const memory = setup({ memoryOnly: true });
    void memory.guide.start();
    const tour = await shown();
    expect(tour.steps[0]!.popover?.description).toContain(
      "Memory-only mode forgets notes and this guide preference",
    );
    memory.guide.destroy();
    document.body.replaceChildren();
    const persistent = setup();
    void persistent.guide.start();
    const second = await shown(2);
    expect(second.steps[0]!.popover?.description).toContain(
      "Skip or Finish remembers this guide",
    );
    persistent.guide.destroy();
  });

  it("disables animation for reduced motion", async () => {
    reducedMotion = true;
    const { guide } = setup();
    void guide.start();
    const tour = await shown();
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(tour.config.animate).toBe(false);
    expect(tour.config.allowKeyboardControl).toBe(false);
    guide.destroy();
  });
});

describe("remembering the choice", () => {
  it("keeps the tour open and explains when saving the choice fails", async () => {
    const { store, host, guide } = setup();
    const failure = new Error("Quota exceeded");
    let finishWrite!: () => void;
    store.put
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishWrite = resolve)),
      );
    const started = guide.start();
    const tour = await shown();
    tour.skip();
    await vi.waitFor(() => expect(host.error).toHaveBeenCalledWith(failure));
    const alert = () =>
      tour.popover!.querySelectorAll<HTMLElement>("[role=alert]");
    expect(alert()).toHaveLength(1);
    expect(alert()[0]!.textContent).toBe(
      "Could not remember your choice. Try Skip or Finish again.",
    );
    expect(guide.active).toBe(true);

    key({ key: "Escape" });
    await vi.waitFor(() => expect(host.error).toHaveBeenCalledTimes(2));
    expect(alert()).toHaveLength(1);

    tour.skip();
    tour.skip();
    key({ key: "Escape" });
    expect(store.put).toHaveBeenCalledTimes(3);
    finishWrite();
    await started;
    expect(guide.active).toBe(false);
  });
});

describe("modal behaviour while the tour is open", () => {
  it("traps Tab inside the popover and practice controls", async () => {
    const rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);
    const { guide } = setup();
    void guide.start();
    const tour = await shown();
    tour.next();
    tour.next();
    expect(tour.step.popover?.title).toBe("Try Markdown");
    const buttons = [...tour.popover!.querySelectorAll("button")];
    const first = key({ key: "Tab" });
    expect(first.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    key({ key: "Tab" });
    expect(document.activeElement).toBe(buttons[1]);
    key({ key: "Tab", shiftKey: true });
    key({ key: "Tab", shiftKey: true });
    const practiceControls = document.querySelectorAll<HTMLElement>(
      '#onboarding-practice button:not(:disabled), #onboarding-practice [tabindex="0"], #onboarding-practice [contenteditable="true"]',
    );
    expect(document.activeElement).toBe(
      [...practiceControls].filter((node) => node.tabIndex >= 0).at(-1),
    );
    rects.mockReturnValue([] as unknown as DOMRectList);
    expect(key({ key: "Tab" }).defaultPrevented).toBe(false);
    expect(key({ key: "a" }).defaultPrevented).toBe(false);
    guide.destroy();
  });

  it("returns focus to the popover when it escapes to the workspace", async () => {
    const { root, guide } = setup();
    void guide.start();
    const tour = await shown();
    const outside = root.querySelector<HTMLElement>("#editing")!;
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(document.activeElement).toBe(tour.popover!.querySelector("button"));
    const inside = tour.popover!.querySelectorAll("button")[2]!;
    inside.focus();
    inside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(document.activeElement).toBe(inside);
    guide.destroy();
  });

  it("blocks file drops until the tour closes", async () => {
    const { guide } = setup();
    void guide.start();
    await shown();
    const reached = vi.fn();
    document.body.addEventListener("drop", reached);
    const drop = () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event;
    };
    const dragover = new Event("dragover", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(dragover);
    expect(dragover.defaultPrevented).toBe(true);
    expect(drop().defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
    guide.destroy();
    expect(drop().defaultPrevented).toBe(false);
    expect(reached).toHaveBeenCalledOnce();
  });

  it("repositions on resize and stops listening afterwards", async () => {
    const { guide } = setup();
    void guide.start();
    const tour = await shown();
    window.dispatchEvent(new Event("resize"));
    expect(tour.refresh).toHaveBeenCalledOnce();
    guide.destroy();
    window.dispatchEvent(new Event("resize"));
    expect(tour.refresh).toHaveBeenCalledOnce();
  });

  it("closes without remembering when the tab is hidden, then offers it again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const { store, guide } = setup();
    void guide.start();
    const tour = await shown();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(guide.active).toBe(true);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tour.destroyed).toBe(true);
    await vi.waitFor(() => expect(guide.active).toBe(false));
    expect(document.querySelector("#onboarding-practice")).toBeNull();
    expect(store.put).not.toHaveBeenCalled();
    visibility = "visible";
    await vi.advanceTimersByTimeAsync(1000);
    await shown(2);
    guide.destroy();
  });
});

describe("automatic start and replay", () => {
  it("retries every second until the app is available", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { state, guide } = setup();
    state.available = false;
    await guide.start();
    expect(lockRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(lockRequest).not.toHaveBeenCalled();
    state.available = true;
    await vi.advanceTimersByTimeAsync(1000);
    await shown();
    guide.destroy();
  });

  it("stops retrying once the preference says the guide was handled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { guide, host } = setup({ handled: true });
    await guide.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lockRequest).toHaveBeenCalledOnce();
    expect(tours).toHaveLength(0);
    expect(guide.active).toBe(false);
    expect(host.changed).toHaveBeenCalledTimes(2);
  });

  it("waits while another tab holds the guide", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    lockFree = false;
    const { store, guide } = setup();
    await guide.start();
    expect(store.value).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(lockRequest).toHaveBeenCalledTimes(2);
    lockFree = true;
    await vi.advanceTimersByTimeAsync(1000);
    await shown();
    guide.destroy();
  });

  it("does not start when the app becomes busy inside the lock", async () => {
    const { state, store, guide } = setup();
    store.value.mockImplementation(async () => {
      state.available = false;
      return undefined;
    });
    await guide.start();
    expect(tours).toHaveLength(0);
    guide.destroy();
  });

  it("reports a broken tour once and stops retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    driverMock.failDrive = true;
    const { root, host, guide } = setup();
    await guide.start();
    expect(host.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Tour failed to render" }),
    );
    expect(tours[0]!.destroyed).toBe(true);
    expect(guide.active).toBe(false);
    expect(root.classList.contains("guide-active")).toBe(false);
    expect(document.querySelector("#onboarding-practice")).toBeNull();
    expect(document.querySelector(".guide-center")).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lockRequest).toHaveBeenCalledOnce();
  });

  it("reports a missing workspace instead of showing a broken tour", async () => {
    const { host, guide } = setup({ workspace: false });
    await guide.start();
    expect(host.error).toHaveBeenCalledWith(expect.any(TypeError));
    expect(tours).toHaveLength(0);
  });

  it("replays even after the guide was handled, without rereading the preference", async () => {
    const { store, guide } = setup({ handled: true });
    guide.replay();
    const tour = await shown();
    expect(store.value).not.toHaveBeenCalled();
    guide.replay();
    void guide.start();
    await Promise.resolve();
    expect(tours).toHaveLength(1);
    tour.next();
    tour.next();
    tour.next();
    tour.next();
    tour.next();
    await vi.waitFor(() => expect(guide.active).toBe(false));
    expect(store.put).toHaveBeenCalledWith(GUIDE_SETTING, true);
    guide.destroy();
  });

  it("explains why a replay cannot start", async () => {
    const { state, host, guide } = setup();
    state.available = false;
    guide.replay();
    await vi.waitFor(() =>
      expect(host.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Finish the current operation before replaying the guide.",
        }),
      ),
    );
    expect(lockRequest).not.toHaveBeenCalled();
    state.available = true;
    lockFree = false;
    guide.replay();
    await vi.waitFor(() =>
      expect(host.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "The guide is open in another MarkNotes tab.",
        }),
      ),
    );
    expect(guide.active).toBe(false);
  });

  it("closes without remembering when destroyed and ignores later replays", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, guide } = setup();
    const started = guide.start();
    const tour = await shown();
    guide.destroy();
    await started;
    expect(tour.destroyed).toBe(true);
    expect(guide.active).toBe(false);
    expect(store.put).not.toHaveBeenCalled();
    guide.replay();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tours).toHaveLength(1);
    expect(lockRequest).toHaveBeenCalledOnce();
  });
});

describe("tour anchors", () => {
  it("accepts on-screen targets and rejects off-screen ones", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button id="new">New</button>';
    document.body.append(root);
    const target = root.querySelector<HTMLElement>("#new")!;
    vi.spyOn(target, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const bounds = vi.spyOn(target, "getBoundingClientRect");
    bounds.mockReturnValue(new DOMRect(0, 0, 40, 20));
    expect(visibleTarget(root, "#new")).toBe(target);
    for (const rect of [
      new DOMRect(-50, 0, 40, 20),
      new DOMRect(0, -30, 40, 20),
      new DOMRect(innerWidth, 0, 40, 20),
      new DOMRect(0, innerHeight, 40, 20),
    ]) {
      bounds.mockReturnValue(rect);
      expect(visibleTarget(root, "#new")).toBeUndefined();
    }
  });
});

describe("practice controls", () => {
  function mount() {
    const demo = practice();
    document.body.append(demo.root);
    const control = (label: string) =>
      [...demo.root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === label,
      )!;
    return { demo, control };
  }

  it("formats the practice text and switches views", () => {
    const { demo, control } = mount();
    try {
      const doc = () => demo.editor.state.doc.toString();
      const start = doc();
      demo.editor.dispatch({ selection: { anchor: 2, head: 9 } });
      control("Practice bold").click();
      expect(doc()).not.toBe(start);
      expect(doc()).toContain("**Welcome**");
      const bolded = doc();
      control("Practice italic").click();
      expect(doc()).not.toBe(bolded);
      demo.editor.dispatch({ selection: { anchor: 0 } });
      const italic = doc();
      control("Practice heading").click();
      expect(doc()).not.toBe(italic);
      expect(demo.root.querySelector("article h1, article h2")).not.toBeNull();

      const panes = demo.root.querySelector<HTMLElement>(
        ".guide-practice-panes",
      )!;
      const [source, output] = [...panes.children] as HTMLElement[];
      control("Preview").click();
      expect(panes.dataset.view).toBe("preview");
      expect(source!.hidden).toBe(true);
      expect(output!.hidden).toBe(false);
      control("Edit").click();
      expect(panes.dataset.view).toBe("edit");
      expect(source!.hidden).toBe(false);
      expect(output!.hidden).toBe(true);
      control("Split").click();
      expect(source!.hidden || output!.hidden).toBe(false);
    } finally {
      demo.destroy();
    }
  });

  it("refuses pasted files and does not follow preview links", () => {
    const { demo } = mount();
    try {
      const paste = (types: string[]) => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { types } });
        demo.root.querySelector("h2")!.dispatchEvent(event);
        return event;
      };
      expect(paste(["Files"]).defaultPrevented).toBe(true);
      expect(paste(["text/plain"]).defaultPrevented).toBe(false);
      const output = demo.root.querySelector("article")!;
      output.innerHTML = '<p><a href="https://example.com">x</a> text</p>';
      const link = new MouseEvent("click", { bubbles: true, cancelable: true });
      output.querySelector("a")!.dispatchEvent(link);
      expect(link.defaultPrevented).toBe(true);
      const text = new MouseEvent("click", { bubbles: true, cancelable: true });
      output.querySelector("p")!.dispatchEvent(text);
      expect(text.defaultPrevented).toBe(false);
    } finally {
      demo.destroy();
    }
  });
});
