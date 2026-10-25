import { element } from "./components";

export interface Platform {
  label: string;
  url: string;
}

/** The other MarkNotes apps; this web app never lists itself. */
export const OTHER_PLATFORMS: readonly Platform[] = [
  {
    label: "MarkNotes for Android (F-Droid)",
    url: "https://f-droid.org/packages/io.github.maxdac.marknotes.libre/",
  },
  {
    label: "MarkNotes Plus for Android (GitHub Releases)",
    url: "https://github.com/MaxDac/MarkNotes/releases",
  },
  {
    label: "MarkNotes Desktop (GitHub Releases)",
    url: "https://github.com/MaxDac/marknotes-electron/releases",
  },
];

export function platformLinks(): HTMLUListElement {
  const list = element("ul", undefined, "platform-links");
  list.setAttribute("aria-label", "MarkNotes on other platforms");
  for (const { label, url } of OTHER_PLATFORMS) {
    const link = element("a", label);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const item = element("li");
    item.append(link);
    list.append(item);
  }
  return list;
}
