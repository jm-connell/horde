/** Minimal element surface so this stays testable without a DOM. */
export interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/** Focus is somewhere text is typed: single-key shortcuts must stay out. */
export function isTextEntryTarget(target: unknown): boolean {
  const el = target as KeyTarget | null;
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT") {
    // Range/checkbox/radio/button inputs are not text entry, but they use
    // arrows (sliders) or Space themselves; the caller treats them as controls.
    const type = (el.getAttribute?.("type") ?? "text").toLowerCase();
    return ![
      "button",
      "checkbox",
      "radio",
      "range",
      "submit",
      "reset",
    ].includes(type);
  }
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  const editable = el.getAttribute?.("contenteditable");
  return (
    editable === "" || editable === "true" || editable === "plaintext-only"
  );
}

const CONTROL_SELECTOR = [
  "button",
  "link",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "tab",
  "switch",
  "checkbox",
  "radio",
  "option",
  "slider",
]
  .map((role) => `[role="${role}"]`)
  .join(",");

/**
 * Focus is on something that handles Space/Enter (or arrows) itself, so the
 * player must not also react to the same key.
 */
export function isInteractiveControl(target: unknown): boolean {
  const el = target as KeyTarget | null;
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || tag === "INPUT") {
    return true;
  }
  return Boolean(el.closest?.(CONTROL_SELECTOR));
}

const ARROW_OWNER_SELECTOR = [
  "slider",
  "menu",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "listbox",
  "option",
  "tablist",
  "tab",
  "radiogroup",
  "radio",
]
  .map((role) => `[role="${role}"]`)
  .join(",");

/** Focus is in a widget that uses the arrow keys itself (sliders, menus...). */
export function ownsArrowKeys(target: unknown): boolean {
  const el = target as KeyTarget | null;
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
  return Boolean(el.closest?.(ARROW_OWNER_SELECTOR));
}
