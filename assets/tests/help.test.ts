// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownExamples, showHelp, showMarkdownHelp } from "../js/help";

beforeEach(() => {
  for (const method of ["showModal", "close"] as const)
    Object.defineProperty(HTMLDialogElement.prototype, method, {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = method === "showModal";
      },
    });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  document.body.replaceChildren();
});

function dialogs(): HTMLDialogElement[] {
  return [...document.querySelectorAll("dialog")];
}

function title(): string | null | undefined {
  const dialog = dialogs().at(-1);
  const id = dialog?.getAttribute("aria-labelledby");
  return id ? document.getElementById(id)?.textContent : undefined;
}

function press(label: string): void {
  const button = [...document.querySelectorAll("dialog button")].find(
    (node) =>
      node.textContent === label || node.getAttribute("aria-label") === label,
  );
  if (!(button instanceof HTMLButtonElement))
    throw new Error(`No ${label} button`);
  button.click();
}

describe("Help", () => {
  it("explains persistent guide behaviour and closes with Done", () => {
    const replay = vi.fn();
    showHelp(replay, false);
    expect(title()).toBe("Help");
    expect(dialogs()[0]!.open).toBe(true);
    expect(document.body.textContent).toContain(
      "The first-access guide appears once in this browser profile",
    );
    expect(document.body.textContent).not.toContain("Memory-only mode");
    press("Done");
    expect(dialogs()).toHaveLength(0);
    expect(replay).not.toHaveBeenCalled();
  });

  it("explains memory-only guide behaviour", () => {
    showHelp(vi.fn(), true);
    expect(document.body.textContent).toContain(
      "Memory-only mode saves no notes or guide preference to disk.",
    );
  });

  it("closes before replaying the guide", () => {
    const replay = vi.fn(() => expect(dialogs()).toHaveLength(0));
    showHelp(replay, false);
    document.querySelector<HTMLButtonElement>("#replay-guide")!.click();
    expect(replay).toHaveBeenCalledOnce();
  });

  it("dismisses with the close button or Escape without side effects", () => {
    const replay = vi.fn();
    showHelp(replay, false);
    press("Close");
    expect(dialogs()).toHaveLength(0);
    showHelp(replay, false);
    const cancel = new Event("cancel", { cancelable: true });
    dialogs()[0]!.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialogs()).toHaveLength(0);
    expect(replay).not.toHaveBeenCalled();
  });

  it("opens Markdown help and returns to the same Help options", () => {
    const replay = vi.fn();
    showHelp(replay, true);
    document.querySelector<HTMLButtonElement>("#markdown-help")!.click();
    expect(dialogs()).toHaveLength(1);
    expect(title()).toBe("Markdown in MarkNotes Web");
    expect(dialogs()[0]!.classList.contains("markdown-help")).toBe(true);

    press("Back to Help");
    expect(dialogs()).toHaveLength(1);
    expect(title()).toBe("Help");
    expect(document.body.textContent).toContain("Memory-only mode");

    document.querySelector<HTMLButtonElement>("#markdown-help")!.click();
    press("Close");
    expect(title()).toBe("Help");

    document.querySelector<HTMLButtonElement>("#replay-guide")!.click();
    expect(replay).toHaveBeenCalledOnce();
    expect(dialogs()).toHaveLength(0);
  });
});

describe("Markdown help", () => {
  it("closes with Done without returning to Help", () => {
    const back = vi.fn();
    showMarkdownHelp(back);
    press("Done");
    expect(dialogs()).toHaveLength(0);
    expect(back).not.toHaveBeenCalled();
  });

  it("pairs every source example with its rendered preview", () => {
    showMarkdownHelp(vi.fn());
    const sections = document.querySelectorAll(".markdown-example");
    expect(sections).toHaveLength(markdownExamples.length);
    markdownExamples.forEach((example, index) => {
      const section = sections[index]!;
      expect(section.querySelector("h4")?.textContent).toBe(example.title);
      expect(section.querySelector("pre code")?.textContent).toBe(
        example.source,
      );
      expect(
        section.querySelector(".help-preview")?.getAttribute("aria-label"),
      ).toBe(`${example.title} rendered example`);
    });
  });

  it("does not navigate away from example links", () => {
    showMarkdownHelp(vi.fn());
    const preview = [...document.querySelectorAll(".help-preview")].find(
      (node) => node.querySelector("a"),
    )!;
    const link = new MouseEvent("click", { bubbles: true, cancelable: true });
    preview.querySelector("a")!.dispatchEvent(link);
    expect(link.defaultPrevented).toBe(true);
    const text = new MouseEvent("click", { bubbles: true, cancelable: true });
    preview.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
  });
});
