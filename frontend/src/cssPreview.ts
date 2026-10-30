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
const PREVIEW_ATTR = "data-css-preview";

function previewTag(owner: string): HTMLStyleElement | null {
  return document.querySelector<HTMLStyleElement>(
    `style[${PREVIEW_ATTR}="${CSS.escape(owner)}"]`
  );
}

/** Try `css` on the page; `owner` (the card) removes it again. */
export function showCssPreview(owner: string, css: string): void {
  let el = previewTag(owner);
  if (!el) {
    el = document.createElement("style");
    el.setAttribute(PREVIEW_ATTR, owner);
    el.setAttribute("data-horde", "custom-css-preview");
    document.head.appendChild(el);
  }
  el.textContent = sanitizeCustomCss(normalizeCustomCss(css));
}

export function clearCssPreview(owner: string): void {
  previewTag(owner)?.remove();
}

/** The saved stylesheet with `addition` after it, or null when too long. */
export function appendCss(saved: string, addition: string): string | null {
  const base = saved.trimEnd();
  const next = base
    ? `${base}\n\n${addition.trim()}\n`
    : `${addition.trim()}\n`;
  return next.length <= CUSTOM_CSS_MAX_CHARS ? next : null;
}
