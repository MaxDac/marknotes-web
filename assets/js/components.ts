const NS = "http://www.w3.org/2000/svg";
const paths = {
  plus: "M12 5v14M5 12h14",
  folder:
    "M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z",
  file: "M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5M9 13h6M9 17h4",
  notes: "M5 4h14v16H5zM9 8h6M9 12h6M9 16h3",
  chords:
    "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 9l11-2",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  trash:
    "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  cloud: "M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 11.5 3.25 3.25 0 0 1 17.5 18z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  close: "M6 6l12 12M18 6 6 18",
  chevron: "M9 6l6 6-6 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4",
  block: "M4 5h16v14H4zM10 10l-2 2 2 2M14 10l2 2-2 2",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  checklist: "M4 6.5 5.5 8 8 5M4 13.5 5.5 15 8 12M11 7h9M11 14h9M11 19h9",
  quote: "M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6",
  check: "M5 12.5l4.5 4.5L19 7",
  plug: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01",
  copy: "M9 9h11v11H9zM5 15V4h11",
  alert:
    "M12 8v5M12 16h.01M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z",
} as const;
export type IconName = keyof typeof paths;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg"),
    path = document.createElementNS(NS, "path");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}

/** The shared MarkNotes mark, generated from branding/marknotes-mark.svg. */
export function logo(): HTMLImageElement {
  const img = element("img", undefined, "logo");
  img.src = "/images/marknotes-mark.svg";
  img.alt = "";
  img.width = 30;
  img.height = 30;
  return img;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

export type Variant = "solid" | "outline" | "ghost" | "danger";
export interface ButtonOptions {
  icon?: IconName;
  variant?: Variant;
  iconOnly?: boolean;
  id?: string;
  className?: string;
}
export function button(
  text: string,
  action?: () => void,
  options: ButtonOptions = {},
): HTMLButtonElement {
  const b = element(
    "button",
    undefined,
    `btn btn-${options.variant ?? "ghost"}${options.iconOnly ? " btn-icon" : ""}${options.className ? ` ${options.className}` : ""}`,
  );
  b.type = "button";
  if (options.id) b.id = options.id;
  if (options.icon) b.append(icon(options.icon));
  if (options.iconOnly) {
    b.setAttribute("aria-label", text);
    b.title = text;
  } else b.append(element("span", text));
  if (action) b.addEventListener("click", action);
  return b;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  action: () => void;
}
/** Attaches an accessible dropdown menu to `trigger`, returning a wrapper. */
export function menu(
  trigger: HTMLButtonElement,
  items: () => MenuItem[],
  align: "start" | "end" = "start",
): HTMLElement {
  const anchor = element("div", undefined, "menu-anchor");
  anchor.append(trigger);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  let popup: HTMLElement | undefined;
  const outside = (event: PointerEvent) => {
    if (!anchor.contains(event.target as Node)) close(false);
  };
  const close = (focus: boolean) => {
    if (!popup) return;
    popup.remove();
    popup = undefined;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (focus) trigger.focus();
  };
  const open = (last = false) => {
    popup = element("div", undefined, `menu menu-${align}`);
    popup.setAttribute("role", "menu");
    popup.setAttribute(
      "aria-label",
      trigger.getAttribute("aria-label") ?? trigger.textContent ?? "",
    );
    for (const item of items()) {
      const entry = button(
        item.label,
        () => {
          close(true);
          item.action();
        },
        {
          icon: item.icon,
          className: item.danger ? "menu-item danger" : "menu-item",
        },
      );
      entry.setAttribute("role", "menuitem");
      entry.tabIndex = -1;
      popup.append(entry);
    }
    popup.addEventListener("keydown", (event) => {
      const entries = [
          ...popup!.querySelectorAll<HTMLElement>("[role=menuitem]"),
        ],
        index = entries.indexOf(document.activeElement as HTMLElement);
      const move = (to: number) => {
        event.preventDefault();
        entries[(to + entries.length) % entries.length]?.focus();
      };
      if (event.key === "ArrowDown") move(index + 1);
      else if (event.key === "ArrowUp") move(index - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(entries.length - 1);
      else if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Tab") close(false);
    });
    anchor.append(popup);
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    const entries = popup.querySelectorAll<HTMLElement>("[role=menuitem]");
    entries[last ? entries.length - 1 : 0]?.focus();
  };
  trigger.addEventListener("click", () => (popup ? close(true) : open()));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!popup) open(event.key === "ArrowUp");
    }
  });
  return anchor;
}

export interface Choice {
  value: string;
  label: string;
  icon?: IconName;
  swatch?: string;
}
/** Single-select radio group rendered as a segmented control or swatches. */
export function segmented(
  label: string,
  choices: Choice[],
  value: string,
  onChange: (value: string) => void,
  className = "segmented",
): HTMLElement {
  const group = element("div", undefined, className);
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  const radios = choices.map((choice) => {
    const radio = choice.swatch
      ? button(choice.label, undefined, { iconOnly: true, className: "swatch" })
      : button(choice.label, undefined, {
          icon: choice.icon,
          className: "segment",
        });
    radio.classList.remove("btn-ghost");
    radio.setAttribute("role", "radio");
    if (choice.swatch) {
      radio.style.setProperty("--swatch", choice.swatch);
      radio.append(icon("check"));
    }
    radio.dataset.value = choice.value;
    radio.addEventListener("click", () => select(choice.value, true));
    group.append(radio);
    return radio;
  });
  const select = (next: string, notify: boolean) => {
    for (const radio of radios) {
      const on = radio.dataset.value === next;
      radio.setAttribute("aria-checked", String(on));
      radio.tabIndex = on ? 0 : -1;
    }
    if (notify) onChange(next);
  };
  group.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      event.key
    ];
    if (!step) return;
    event.preventDefault();
    const index = radios.indexOf(document.activeElement as HTMLButtonElement),
      next = radios[(index + step + radios.length) % radios.length]!;
    next.focus();
    select(next.dataset.value!, true);
  });
  select(value, false);
  return group;
}

export function toggle(label: string, checked: boolean): HTMLButtonElement {
  const control = element("button", undefined, "switch");
  control.type = "button";
  control.setAttribute("role", "switch");
  control.setAttribute("aria-checked", String(checked));
  control.append(
    element("span", undefined, "switch-track"),
    element("span", label),
  );
  control.addEventListener("click", () =>
    control.setAttribute(
      "aria-checked",
      String(control.getAttribute("aria-checked") !== "true"),
    ),
  );
  return control;
}
export const checked = (control: HTMLElement) =>
  control.getAttribute("aria-checked") === "true";

let dialogs = 0;
export interface Dialog {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  footer: HTMLElement;
  error: HTMLElement;
  close: () => void;
}
/** Opens a styled modal; `onCancel` runs for Escape and the close button. */
export function openDialog(
  title: string,
  onCancel: () => void,
  className = "",
): Dialog {
  const dialog = element("dialog", undefined, `modal ${className}`),
    id = `dialog-title-${++dialogs}`;
  const header = element("header", undefined, "modal-header"),
    heading = element("h2", title),
    body = element("div", undefined, "modal-body"),
    error = element("p", undefined, "field-error"),
    footer = element("footer", undefined, "modal-footer");
  heading.id = id;
  dialog.setAttribute("aria-labelledby", id);
  error.setAttribute("role", "alert");
  error.hidden = true;
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const cancel = () => {
    close();
    onCancel();
  };
  header.append(
    heading,
    button("Close", cancel, { icon: "close", iconOnly: true }),
  );
  dialog.append(header, body, error, footer);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancel();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, footer, error, close };
}
export function showError(error: HTMLElement, text: string): void {
  error.hidden = !text;
  error.textContent = text;
}

export function ask(options: {
  title: string;
  label: string;
  value?: string;
  confirm: string;
  hint?: string;
  validate?: (value: string) => void;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const { body, footer, error, close } = openDialog(options.title, () =>
      resolve(null),
    );
    const form = element("form", undefined, "field"),
      label = element("label", options.label),
      input = element("input", undefined, "input");
    const id = `field-${dialogs}`;
    label.htmlFor = id;
    input.id = id;
    input.value = options.value ?? "";
    input.autocomplete = "off";
    input.spellcheck = false;
    form.append(label, input);
    if (options.hint) form.append(element("p", options.hint, "hint"));
    const submit = () => {
      try {
        options.validate?.(input.value);
        close();
        resolve(input.value);
      } catch (e) {
        showError(error, e instanceof Error ? e.message : String(e));
        input.focus();
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    body.append(form);
    footer.append(
      button(
        "Cancel",
        () => {
          close();
          resolve(null);
        },
        { variant: "outline" },
      ),
      button(options.confirm, submit, { variant: "solid" }),
    );
    input.focus();
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  });
}

export function confirmDialog(options: {
  title: string;
  text: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return confirmWithOption(options).then((result) => result !== null);
}

/**
 * A confirmation that can also show a checkbox (`option`). Resolves to null when cancelled, else to whether the
 * checkbox was ticked. `optionText` replaces `text` while the checkbox is ticked.
 */
export function confirmWithOption(options: {
  title: string;
  text: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
  option?: { label: string; id: string; text?: string };
}): Promise<{ option: boolean } | null> {
  return new Promise((resolve) => {
    const { body, footer, close } = openDialog(options.title, () =>
      resolve(null),
    );
    const text = element("p", options.text);
    body.append(text);
    let box: HTMLInputElement | undefined;
    if (options.option) {
      const { label, id, text: alt } = options.option;
      const row = element("label", undefined, "check");
      box = element("input");
      box.type = "checkbox";
      box.id = id;
      box.addEventListener("change", () => {
        text.textContent = box!.checked && alt ? alt : options.text;
      });
      row.append(box, element("span", label));
      body.append(row);
    }
    const ok = button(
      options.confirm,
      () => {
        close();
        resolve({ option: box?.checked ?? false });
      },
      { variant: options.danger ? "danger" : "solid" },
    );
    footer.append(
      button(
        options.cancel ?? "Cancel",
        () => {
          close();
          resolve(null);
        },
        { variant: "outline" },
      ),
      ok,
    );
    ok.focus();
  });
}

/** Password field with a label; `autocomplete` lets password managers tell current and new passphrases apart. */
export function passwordField(
  text: string,
  autocomplete: "current-password" | "new-password",
): { field: HTMLElement; input: HTMLInputElement } {
  const field = element("div", undefined, "field"),
    label = element("label", text),
    input = element("input", undefined, "input");
  input.type = "password";
  input.id = `password-${++dialogs}`;
  input.autocomplete = autocomplete;
  input.spellcheck = false;
  label.htmlFor = input.id;
  field.append(label, input);
  return { field, input };
}

/**
 * Asks for the current and/or a new passphrase (typed twice) and runs `submit` inside the dialog, so errors such as
 * a wrong passphrase are shown next to the fields. Resolves `true` once `submit` succeeds, `false` if cancelled.
 */
export function passphraseDialog(options: {
  title: string;
  text: string;
  confirm: string;
  current?: boolean;
  next?: boolean;
  danger?: boolean;
  submit: (values: { current: string; next: string }) => Promise<void>;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const { body, footer, error, close } = openDialog(options.title, () =>
      resolve(false),
    );
    const form = element("form", undefined, "fields");
    const current = options.current
      ? passwordField("Current passphrase", "current-password")
      : undefined;
    const next = options.next
      ? passwordField("New passphrase", "new-password")
      : undefined;
    const again = options.next
      ? passwordField("Repeat new passphrase", "new-password")
      : undefined;
    for (const f of [current, next, again]) if (f) form.append(f.field);
    const ok = button(options.confirm, () => form.requestSubmit(), {
      variant: options.danger ? "danger" : "solid",
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (next && next.input.value !== again!.input.value) {
        showError(error, "The new passphrases do not match.");
        again!.input.focus();
        return;
      }
      ok.disabled = true;
      showError(error, "");
      options
        .submit({
          current: current?.input.value ?? "",
          next: next?.input.value ?? "",
        })
        .then(() => {
          close();
          resolve(true);
        })
        .catch((e: unknown) => {
          ok.disabled = false;
          showError(error, e instanceof Error ? e.message : String(e));
          (current ?? next)!.input.focus();
        });
    });
    form.append(
      Object.assign(element("button"), { type: "submit", hidden: true }),
    );
    body.append(element("p", options.text), form);
    footer.append(
      button(
        "Cancel",
        () => {
          close();
          resolve(false);
        },
        { variant: "outline" },
      ),
      ok,
    );
    (current ?? next)!.input.focus();
  });
}
