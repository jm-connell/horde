import {
  CUSTOM_CSS_MAX_CHARS,
  normalizeCustomCss,
  sanitizeCustomCss,
} from "./customCss";

/**
 * CSS Ask about Horde wrote, tried on the page before the user keeps it: a
 * second style tag after the saved custom CSS (so its rules win), cleaned by
 * the same sanitizer. Nothing is saved until the user keeps it.
 */
const PREVIEW_STYLE_ID = "horde-custom-css-preview";

export function showCssPreview(css: string): void {
  let el = document.getElementById(PREVIEW_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = PREVIEW_STYLE_ID;
    el.setAttribute("data-horde", "custom-css-preview");
    document.head.appendChild(el);
  }
  el.textContent = sanitizeCustomCss(normalizeCustomCss(css));
}

export function clearCssPreview(): void {
  document.getElementById(PREVIEW_STYLE_ID)?.remove();
}

/** The saved stylesheet with `addition` after it, or null when too long. */
export function appendCss(saved: string, addition: string): string | null {
  const base = saved.trimEnd();
  const next = base
    ? `${base}\n\n${addition.trim()}\n`
    : `${addition.trim()}\n`;
  return next.length <= CUSTOM_CSS_MAX_CHARS ? next : null;
}
