// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ask,
  button,
  checked,
  confirmDialog,
  confirmWithOption,
  element,
  icon,
  logo,
  menu,
  openDialog,
  passphraseDialog,
  passwordField,
  segmented,
  showError,
  toggle,
} from "../js/components";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  document.body.replaceChildren();
});

const key = (target: Element, key: string) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
const buttonNamed = (name: string, root: ParentNode = document) =>
  [...root.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  )!;
const dialog = () => document.querySelector("dialog")!;

describe("elements", () => {
  it("builds decorative icons, the logo and plain elements", () => {
    const svg = icon("plus");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(
      "M12 5v14M5 12h14",
    );
    const img = logo();
    expect(img.alt).toBe("");
    expect(img.getAttribute("src")).toBe("/images/marknotes-mark.svg");
    const p = element("p", "text", "hint");
    expect(p.outerHTML).toBe('<p class="hint">text</p>');
    expect(element("div").className).toBe("");
  });

  it("builds labelled buttons and icon-only buttons", () => {
    const action = vi.fn();
    const plain = button("Save", action, {
      variant: "solid",
      id: "save",
      className: "wide",
    });
    expect(plain.className).toBe("btn btn-solid wide");
    expect(plain.type).toBe("button");
    expect(plain.id).toBe("save");
    expect(plain.textContent).toBe("Save");
    plain.click();
    expect(action).toHaveBeenCalledOnce();
    const only = button("Close", undefined, { icon: "close", iconOnly: true });
    expect(only.className).toBe("btn btn-ghost btn-icon");
    expect(only.getAttribute("aria-label")).toBe("Close");
    expect(only.title).toBe("Close");
    expect(only.querySelector("svg")).not.toBeNull();
    expect(only.querySelector("span")).toBeNull();
  });

  it("toggles switches and shows or hides errors", () => {
    const control = toggle("Auto-format", false);
    expect(control.getAttribute("role")).toBe("switch");
    expect(checked(control)).toBe(false);
    control.click();
    expect(checked(control)).toBe(true);
    control.click();
    expect(checked(control)).toBe(false);
    const error = element("p");
    showError(error, "Wrong");
    expect([error.hidden, error.textContent]).toEqual([false, "Wrong"]);
    showError(error, "");
    expect(error.hidden).toBe(true);
  });

  it("labels password fields for password managers", () => {
    const { field, input } = passwordField("Passphrase", "new-password");
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    expect(field.querySelector("label")?.htmlFor).toBe(input.id);
  });
});

describe("menu", () => {
  const setup = () => {
    const actions = { rename: vi.fn(), remove: vi.fn() };
    const trigger = button("More", undefined, { iconOnly: true });
    const anchor = menu(
      trigger,
      () => [
        { label: "Rename", icon: "pencil", action: actions.rename },
        { label: "Copy", action: vi.fn() },
        { label: "Delete", danger: true, action: actions.remove },
      ],
      "end",
    );
    document.body.append(anchor);
    const items = () => [
      ...anchor.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ];
    return { actions, trigger, anchor, items };
  };

  it("opens on click, focuses the first item and runs the chosen action", () => {
    const { actions, trigger, anchor, items } = setup();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const popup = anchor.querySelector("[role=menu]")!;
    expect(popup.className).toBe("menu menu-end");
    expect(popup.getAttribute("aria-label")).toBe("More");
    expect(document.activeElement).toBe(items()[0]);
    expect(items()[2]!.className).toContain("danger");
    items()[2]!.click();
    expect(actions.remove).toHaveBeenCalledOnce();
    expect(anchor.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    trigger.click();
    expect(anchor.querySelector("[role=menu]")).toBeNull();
  });

  it("supports arrow, Home, End, Escape and Tab keys", () => {
    const { trigger, anchor, items } = setup();
    key(trigger, "ArrowUp");
    expect(document.activeElement).toBe(items()[2]);
    const popup = anchor.querySelector("[role=menu]")!;
    key(popup, "ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    key(popup, "ArrowUp");
    expect(document.activeElement).toBe(items()[2]);
    key(popup, "Home");
    expect(document.activeElement).toBe(items()[0]);
    key(popup, "End");
    expect(document.activeElement).toBe(items()[2]);
    key(popup, "x");
    key(popup, "Escape");
    expect(anchor.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    key(trigger, "ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    key(trigger, "ArrowDown");
    expect(items()).toHaveLength(3);
    key(anchor.querySelector("[role=menu]")!, "Tab");
    expect(anchor.querySelector("[role=menu]")).toBeNull();
    key(trigger, "Enter");
    expect(anchor.querySelector("[role=menu]")).toBeNull();
  });

  it("closes when the pointer goes down outside it", () => {
    const { trigger, anchor, items } = setup();
    trigger.click();
    items()[0]!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(anchor.querySelector("[role=menu]")).not.toBeNull();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(anchor.querySelector("[role=menu]")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("segmented", () => {
  it("is a radio group with roving focus and change notifications", () => {
    const onChange = vi.fn();
    const group = segmented(
      "Theme",
      [
        { value: "light", label: "Light", icon: "check" },
        { value: "dark", label: "Dark" },
        { value: "blue", label: "Blue", swatch: "#00f" },
      ],
      "dark",
      onChange,
    );
    document.body.append(group);
    const radios = [...group.querySelectorAll<HTMLElement>("[role=radio]")];
    expect(group.getAttribute("aria-label")).toBe("Theme");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios[2]!.style.getPropertyValue("--swatch")).toBe("#00f");
    expect(radios[2]!.className).toContain("swatch");
    expect(onChange).not.toHaveBeenCalled();

    radios[0]!.click();
    expect(onChange).toHaveBeenLastCalledWith("light");
    radios[0]!.focus();
    key(radios[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(radios[2]);
    expect(onChange).toHaveBeenLastCalledWith("blue");
    key(radios[2]!, "ArrowDown");
    expect(onChange).toHaveBeenLastCalledWith("light");
    key(radios[0]!, "Enter");
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe("dialogs", () => {
  it("opens a labelled modal that cancels from Escape and the close button", () => {
    const onCancel = vi.fn();
    const modal = openDialog("Title", onCancel, "wide");
    expect(modal.dialog.open).toBe(true);
    expect(modal.dialog.className).toBe("modal wide");
    const heading = modal.dialog.querySelector("h2")!;
    expect(modal.dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(modal.error.hidden).toBe(true);
    const cancel = new Event("cancel", { cancelable: true });
    modal.dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();

    const again = openDialog("Again", onCancel);
    buttonNamed("Close", again.dialog).click();
    expect(onCancel).toHaveBeenCalledTimes(2);
    const closed = openDialog("Closed", onCancel);
    closed.close();
    expect(document.querySelector("dialog")).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("asks for a value, selecting the name before its extension and validating it", async () => {
    const result = ask({
      title: "Rename",
      label: "Name",
      value: "Note.md",
      confirm: "Rename",
      hint: "No slashes",
      validate: (value) => {
        if (value.includes("/")) throw new Error("No slashes allowed.");
      },
    });
    const input = dialog().querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
    expect(dialog().textContent).toContain("No slashes");
    input.value = "a/b";
    buttonNamed("Rename").click();
    expect(dialog().querySelector("[role=alert]")?.textContent).toBe(
      "No slashes allowed.",
    );
    input.value = "Better";
    dialog().querySelector("form")!.requestSubmit();
    await expect(result).resolves.toBe("Better");
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("resolves null when asking is cancelled, and selects names without an extension", async () => {
    const result = ask({ title: "New", label: "Name", confirm: "Create" });
    expect(dialog().querySelector("input")!.value).toBe("");
    buttonNamed("Cancel").click();
    await expect(result).resolves.toBeNull();

    const dotted = ask({
      title: "New",
      label: "Name",
      value: ".hidden",
      confirm: "Create",
      validate: () => {
        throw "plain";
      },
    });
    const input = dialog().querySelector("input")!;
    expect(input.selectionEnd).toBe(7);
    buttonNamed("Create").click();
    expect(dialog().querySelector("[role=alert]")?.textContent).toBe("plain");
    buttonNamed("Close").click();
    await expect(dotted).resolves.toBeNull();
  });

  it("confirms or cancels", async () => {
    const yes = confirmDialog({
      title: "Delete?",
      text: "Gone forever",
      confirm: "Delete",
      danger: true,
    });
    const ok = buttonNamed("Delete");
    expect(ok.className).toContain("btn-danger");
    expect(document.activeElement).toBe(ok);
    ok.click();
    await expect(yes).resolves.toBe(true);
    const no = confirmDialog({
      title: "Leave?",
      text: "Sure?",
      confirm: "Leave",
      cancel: "Stay",
    });
    expect(buttonNamed("Leave").className).toContain("btn-solid");
    buttonNamed("Stay").click();
    await expect(no).resolves.toBe(false);
  });

  it("reports the optional checkbox and swaps the explanation while ticked", async () => {
    const result = confirmWithOption({
      title: "Disconnect",
      text: "Keep notes",
      confirm: "Disconnect",
      option: { label: "Also delete", id: "delete-too", text: "Delete notes" },
    });
    const box = document.querySelector<HTMLInputElement>("#delete-too")!;
    const text = dialog().querySelector(".modal-body > p")!;
    box.click();
    expect(text.textContent).toBe("Delete notes");
    box.click();
    expect(text.textContent).toBe("Keep notes");
    box.click();
    buttonNamed("Disconnect").click();
    await expect(result).resolves.toEqual({ option: true });

    const plain = confirmWithOption({
      title: "Again",
      text: "Text",
      confirm: "Go",
      option: { label: "Option", id: "opt" },
    });
    document.querySelector<HTMLInputElement>("#opt")!.click();
    expect(dialog().querySelector(".modal-body > p")!.textContent).toBe("Text");
    buttonNamed("Cancel").click();
    await expect(plain).resolves.toBeNull();
  });
});

describe("passphraseDialog", () => {
  const passwords = () => [
    ...dialog().querySelectorAll<HTMLInputElement>("input[type=password]"),
  ];

  it("checks the repeated passphrase, shows submit errors and resolves on success", async () => {
    const submit = vi
      .fn<(values: { current: string; next: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Wrong passphrase."))
      .mockResolvedValue();
    const result = passphraseDialog({
      title: "Change passphrase",
      text: "Choose a new one",
      confirm: "Change",
      current: true,
      next: true,
      submit,
    });
    const [current, next, again] = passwords();
    expect(passwords().map((p) => p.autocomplete)).toEqual([
      "current-password",
      "new-password",
      "new-password",
    ]);
    expect(document.activeElement).toBe(current);
    current!.value = "old";
    next!.value = "new one";
    again!.value = "different";
    buttonNamed("Change").click();
    const alert = dialog().querySelector("[role=alert]")!;
    expect(alert.textContent).toBe("The new passphrases do not match.");
    expect(document.activeElement).toBe(again);
    expect(submit).not.toHaveBeenCalled();

    again!.value = "new one";
    buttonNamed("Change").click();
    expect(buttonNamed("Change").disabled).toBe(true);
    await vi.waitFor(() => expect(alert.textContent).toBe("Wrong passphrase."));
    expect(buttonNamed("Change").disabled).toBe(false);
    expect(document.activeElement).toBe(current);

    buttonNamed("Change").click();
    await expect(result).resolves.toBe(true);
    expect(submit).toHaveBeenLastCalledWith({
      current: "old",
      next: "new one",
    });
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("asks only for the current passphrase and can be cancelled", async () => {
    const submit = vi.fn<() => Promise<void>>().mockRejectedValue("locked");
    const result = passphraseDialog({
      title: "Remove lock",
      text: "Enter it",
      confirm: "Remove",
      current: true,
      danger: true,
      submit,
    });
    expect(passwords()).toHaveLength(1);
    expect(buttonNamed("Remove").className).toContain("btn-danger");
    passwords()[0]!.value = "secret";
    buttonNamed("Remove").click();
    await vi.waitFor(() =>
      expect(dialog().querySelector("[role=alert]")!.textContent).toBe(
        "locked",
      ),
    );
    expect(submit).toHaveBeenCalledWith({ current: "secret", next: "" });
    buttonNamed("Cancel").click();
    await expect(result).resolves.toBe(false);
  });

  it("asks only for a new passphrase", async () => {
    const submit = vi.fn<() => Promise<void>>().mockResolvedValue();
    const result = passphraseDialog({
      title: "Lock",
      text: "Choose",
      confirm: "Lock",
      next: true,
      submit,
    });
    const [next, again] = passwords();
    expect(document.activeElement).toBe(next);
    next!.value = again!.value = "pw";
    buttonNamed("Lock").click();
    await expect(result).resolves.toBe(true);
    expect(submit).toHaveBeenCalledWith({ current: "", next: "pw" });
  });
});
