/** User-authored CSS overlay (Jellyfin-style) plus stable theming hooks. */

export const CUSTOM_CSS_STYLE_ID = "horde-custom-css";
/** Cap keeps localStorage / the server `ui` blob from ballooning. */
export const CUSTOM_CSS_MAX_CHARS = 64_000;

export const CUSTOM_CSS_PLACEHOLDER = `:root {
  --accent: 255 120 40;
}

.ui-card {
  border-radius: 1.25rem;
}

html[data-page="watch"] [data-horde="nav"] {
  background: transparent;
}
`;

export interface CssHookRow {
  selector: string;
  meaning: string;
}

/** Space-separated RGB triples used as `rgb(var(--name) / alpha)`. */
export const CSS_VARIABLES: CssHookRow[] = [
  { selector: "--ink-950", meaning: "Page background" },
  { selector: "--ink-900", meaning: "Panels, cards, chrome fill" },
  { selector: "--ink-800", meaning: "Raised surfaces, inputs" },
  { selector: "--ink-700", meaning: "Borders and rings" },
  { selector: "--ink-600", meaning: "Muted chrome / track fills" },
  { selector: "--accent", meaning: "Accent / interactive color" },
  { selector: "--accent-soft", meaning: "Lighter accent (hover, chips)" },
  { selector: "--accent-deep", meaning: "Darker accent" },
  { selector: "--font-sans", meaning: "UI typeface stack" },
  {
    selector: "--ui-panel-alpha",
    meaning: "Translucent panel fill",
  },
  { selector: "--ui-panel-blur", meaning: "Translucent panel blur" },
  { selector: "--ui-panel-tint", meaning: "Panel tint color (RGB triple)" },
  {
    selector: "--ui-panel-tint-mix",
    meaning: "Panel tint mix amount (percentage)",
  },
];

export const CSS_SELECTORS: CssHookRow[] = [
  {
    selector: "html[data-theme]",
    meaning: "Active palette: oled, light, custom, …",
  },
  {
    selector: 'html[data-panel-tint="on"]',
    meaning: "Panel tint mix is active",
  },
  {
    selector: 'html[data-page="home"]',
    meaning:
      "Library home. Also: watch, settings, history, download, import, playlists",
  },
  { selector: '[data-horde="nav"]', meaning: "Top navigation bar" },
  { selector: '[data-horde="main"]', meaning: "Page content shell" },
  {
    selector: '[data-horde="sidebar"]',
    meaning: "Library channel sidebar rail",
  },
  {
    selector: '[data-horde="channel-list"]',
    meaning: "Channel list inside the sidebar",
  },
  {
    selector: '[data-horde="background"]',
    meaning: "Background effect / image",
  },
  { selector: '[data-horde="video-card"]', meaning: "Library video card" },
  { selector: '[data-horde="feed-card"]', meaning: "Channel feed card" },
  {
    selector: '[data-horde="card-preview-seek"]',
    meaning: "Hover-preview seek bar on a video thumbnail",
  },
  {
    selector: '[data-horde="page-scroll"]',
    meaning: "Document overlay scroll thumb",
  },
  { selector: ".page-shell", meaning: "Centered page column" },
  { selector: ".ui-panel", meaning: "Settings panels, menus, chrome blocks" },
  { selector: ".ui-card", meaning: "Hoverable cards (library, playlists)" },
  { selector: ".ui-interactive", meaning: "Buttons and clickable chrome" },
  { selector: ".horde-scrollbar", meaning: "Themed overlay scroll areas" },
  {
    selector: ".horde-meta-scrollbar",
    meaning:
      "Watch description/chapters, dropdown lists, and settings activity native scrollbar (hidden; overlay thumb on hover/scroll)",
  },
  {
    selector: ".horde-overlay-scroll-thumb",
    meaning: "Solid accent overlay scroll pill (page, description, chapters)",
  },
];

export const PAGE_IDS = [
  "home",
  "watch",
  "settings",
  "history",
  "download",
  "import",
  "playlists",
  /** @deprecated Dedicated playlist pages redirected to `/playlists?open=`. Kept so old custom CSS still type-checks. */
  "playlist",
] as const;

export type PageId = (typeof PAGE_IDS)[number] | "other";

export function pageIdFromPath(pathname: string): PageId {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/watch")) return "watch";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/playlists")) return "playlists";
  if (pathname.startsWith("/history")) return "history";
  if (pathname.startsWith("/download")) return "download";
  if (pathname.startsWith("/import") || pathname.startsWith("/review")) {
    return "import";
  }
  return "other";
}

export function applyPageId(pathname: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.page = pageIdFromPath(pathname);
}

export function normalizeCustomCss(value: unknown): string {
  if (typeof value !== "string") return "";
  const css = value.replace(/\0/g, "");
  if (css.length <= CUSTOM_CSS_MAX_CHARS) return css;
  return css.slice(0, CUSTOM_CSS_MAX_CHARS);
}

/*
 * Remote-fetch stripping. Mirrors backend/app/services/css_sanitize.py (which is
 * what runs when settings are saved); both are tested against the same vectors in
 * customCssSanitize.vectors.json. Keep the two implementations in step.
 */

const URL_FUNCTIONS = new Set([
  "url",
  "src",
  "image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
]);
const CSS_WS = " \t\n\r\f";
const isHex = (ch: string | undefined): boolean =>
  ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
const isIdentChar = (ch: string): boolean =>
  /^[A-Za-z0-9_-]$/.test(ch) || ch.charCodeAt(0) > 0x7f;

function identEnd(css: string, start: number): number {
  let i = start;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "\\") {
      if (i + 1 >= n) return i + 1;
      i += 1;
      if (isHex(css[i])) {
        let digits = 0;
        while (i < n && isHex(css[i]) && digits < 6) {
          i += 1;
          digits += 1;
        }
        if (i < n && CSS_WS.includes(css[i])) i += 1;
      } else {
        i += 1;
      }
    } else if (isIdentChar(ch)) {
      i += 1;
    } else {
      break;
    }
  }
  return i;
}

function cssUnescape(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    i += 1;
    if (i >= n) break;
    if (isHex(text[i])) {
      let j = i;
      while (j < n && isHex(text[j]) && j - i < 6) j += 1;
      const code = parseInt(text.slice(i, j), 16);
      out +=
        code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
      i = j;
      if (i < n && CSS_WS.includes(text[i])) i += 1;
    } else if (text[i] === "\n") {
      i += 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

function stringEnd(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n") return i;
    i += 1;
  }
  return n;
}

function commentEnd(css: string, start: number): number {
  const end = css.indexOf("*/", start + 2);
  return end < 0 ? css.length : end + 2;
}

function parensEnd(css: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = stringEnd(css, i);
      continue;
    }
    if (ch === "/" && css.startsWith("/*", i)) {
      i = commentEnd(css, i);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n;
}

function statementEnd(css: string, start: number): number {
  let i = start;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = stringEnd(css, i);
      continue;
    }
    if (ch === "/" && css.startsWith("/*", i)) {
      i = commentEnd(css, i);
      continue;
    }
    if (ch === "(") {
      i = parensEnd(css, i);
      continue;
    }
    if (ch === ";") return i + 1;
    if (ch === "{" || ch === "}") return i;
    i += 1;
  }
  return n;
}

/** True for `data:` URLs and same-origin relative URLs. */
export function cssUrlAllowed(value: string): boolean {
  const v = Array.from(cssUnescape(value))
    .filter((c) => c >= " " && c !== "\x7f")
    .join("")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/");
  if (!v || v.startsWith("data:")) return true;
  return !(v.startsWith("//") || /^[a-z][a-z0-9+.-]*:/.test(v));
}

function stringValues(text: string): string[] {
  const values: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "/" && text.startsWith("/*", i)) {
      i = commentEnd(text, i);
    } else if (ch === '"' || ch === "'") {
      const end = stringEnd(text, i);
      values.push(text.slice(i + 1, end > i + 1 ? end - 1 : end));
      i = end;
    } else if (ch === "\\") {
      i += 2;
    } else {
      i += 1;
    }
  }
  return values;
}

function callIsSafe(name: string, inner: string): boolean {
  if (name === "url") {
    let value = inner.trim();
    if (value[0] === "'" || value[0] === '"') {
      const end = stringEnd(value, 0);
      value = value.slice(1, end > 1 ? end - 1 : end);
    }
    return cssUrlAllowed(value);
  }
  if (!stringValues(inner).every(cssUrlAllowed)) return false;
  return stripRemoteCss(inner) === inner;
}

/** Remove `@import` and any URL that is not `data:` or same-origin relative. */
export function stripRemoteCss(input: string): string {
  const css = input.replace(/\0/g, "");
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "/" && css.startsWith("/*", i)) {
      const end = commentEnd(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (ch === '"' || ch === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (ch === "@") {
      const end = identEnd(css, i + 1);
      if (cssUnescape(css.slice(i + 1, end)).toLowerCase() === "import") {
        i = statementEnd(css, end);
        continue;
      }
      out += css.slice(i, end);
      i = end;
    } else if (ch === "\\" || isIdentChar(ch)) {
      const end = identEnd(css, i);
      const name = cssUnescape(css.slice(i, end)).toLowerCase();
      if (end < n && css[end] === "(" && URL_FUNCTIONS.has(name)) {
        const close = parensEnd(css, end);
        const closed = close <= n && css[close - 1] === ")";
        const inner = css.slice(end + 1, closed ? close - 1 : close);
        out += callIsSafe(name, inner) ? css.slice(i, close) : "none";
        i = close;
      } else {
        out += css.slice(i, end);
        i = end;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Make CSS safe to inject: no remote fetches, and nothing that could break out
 * of a <style> tag if the CSS is ever assigned via HTML instead of textContent.
 */
export function sanitizeCustomCss(css: string): string {
  return stripRemoteCss(css).replace(/<\/style/gi, (match) =>
    match.replace("/", "\\/")
  );
}

/**
 * Missing `enabled` (older localStorage / theme snapshots) stays on when CSS
 * is already saved so existing overlays keep applying.
 */
export function isCustomCssEnabled(enabled: unknown, css: string): boolean {
  if (typeof enabled === "boolean") return enabled;
  return normalizeCustomCss(css).trim().length > 0;
}

export function applyCustomCss(css: string, enabled = true): void {
  if (typeof document === "undefined") return;
  const next = enabled ? sanitizeCustomCss(normalizeCustomCss(css)) : "";
  let el = document.getElementById(
    CUSTOM_CSS_STYLE_ID
  ) as HTMLStyleElement | null;
  if (!next.trim()) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_CSS_STYLE_ID;
    el.setAttribute("data-horde", "custom-css");
    document.head.appendChild(el);
  }
  el.textContent = next;
}
