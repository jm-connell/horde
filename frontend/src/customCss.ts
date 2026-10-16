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
 *
 * The scanner splits the text into tokens the way a browser does (CSS Syntax
 * Level 3: the url token, bad url tokens, hash tokens and newline
 * preprocessing), so a quote, a comment opener or an escape cannot make it skip
 * text that the browser reads as a url().
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
/** Functions whose value is only known once the browser substitutes it. */
const SUBSTITUTION_FUNCTIONS = new Set(["var", "env", "attr", "if", "inherit"]);
/** Whitespace after preprocessing (CR, CR LF and FF have become LF). */
const CSS_WS = " \t\n";
const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const isHex = (ch: string | undefined): boolean =>
  ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
const isIdentChar = (ch: string): boolean =>
  /^[A-Za-z0-9_-]$/.test(ch) || ch.charCodeAt(0) > 0x7f;
const isWs = (ch: string | undefined): boolean =>
  ch !== undefined && CSS_WS.includes(ch);
const isNonPrintable = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return (
    code <= 0x08 ||
    code === 0x0b ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
};

/** CSS Syntax 3 preprocessing: CR LF, CR and FF are newlines; NUL is dropped. */
function preprocess(css: string): string {
  return css.replace(/\0/g, "").replace(/\r\n?|\f/g, "\n");
}

function isValidEscape(css: string, i: number): boolean {
  return css[i] === "\\" && css[i + 1] !== "\n";
}

/** Index just past the escape whose backslash is at `i`. */
function escapeEnd(css: string, i: number): number {
  const n = css.length;
  i += 1;
  if (i >= n) return n;
  if (!isHex(css[i])) return i + 1;
  let j = i;
  while (j < n && isHex(css[j]) && j - i < 6) j += 1;
  if (isWs(css[j])) j += 1;
  return j;
}

function identEnd(css: string, start: number): number {
  let i = start;
  const n = css.length;
  while (i < n) {
    if (css[i] === "\\") {
      if (!isValidEscape(css, i)) break;
      i = escapeEnd(css, i);
    } else if (isIdentChar(css[i])) {
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
      out += code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
      i = j;
      if (isWs(text[i])) i += 1;
    } else if (text[i] === "\n") {
      i += 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

type TokenKind =
  | "comment"
  | "string"
  | "whitespace"
  | "delim"
  | "hash"
  | "at-keyword"
  | "ident"
  | "function"
  | "url"
  | "bad-url";

/** `arg`: lowercased unescaped name, raw string/url contents, or the delimiter. */
interface Token {
  kind: TokenKind;
  end: number;
  arg: string;
}

function stringToken(css: string, start: number): Token {
  const quote = css[start];
  let i = start + 1;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { kind: "string", end: i + 1, arg: css.slice(start + 1, i) };
    }
    if (ch === "\n") {
      return { kind: "string", end: i, arg: css.slice(start + 1, i) };
    }
    i += 1;
  }
  return { kind: "string", end: n, arg: css.slice(start + 1) };
}

function commentEnd(css: string, start: number): number {
  const end = css.indexOf("*/", start + 2);
  return end < 0 ? css.length : end + 2;
}

function badUrlEnd(css: string, i: number): number {
  const n = css.length;
  while (i < n) {
    if (css[i] === ")") return i + 1;
    i = isValidEscape(css, i) ? escapeEnd(css, i) : i + 1;
  }
  return n;
}

/** The url or bad-url token whose `url(` ends at `start` ("consume a url token"). */
function urlToken(css: string, start: number): Token {
  const n = css.length;
  let i = start;
  while (isWs(css[i])) i += 1;
  const valueStart = i;
  const bad = (from: number): Token => ({
    kind: "bad-url",
    end: badUrlEnd(css, from),
    arg: "",
  });
  while (i < n) {
    const ch = css[i];
    if (ch === ")") {
      return { kind: "url", end: i + 1, arg: css.slice(valueStart, i) };
    }
    if (isWs(ch)) {
      const valueEnd = i;
      while (isWs(css[i])) i += 1;
      if (i >= n) {
        return { kind: "url", end: n, arg: css.slice(valueStart, valueEnd) };
      }
      if (css[i] === ")") {
        return {
          kind: "url",
          end: i + 1,
          arg: css.slice(valueStart, valueEnd),
        };
      }
      return bad(i);
    }
    if (ch === '"' || ch === "'" || ch === "(" || isNonPrintable(ch)) {
      return bad(i);
    }
    if (ch === "\\") {
      if (!isValidEscape(css, i)) return bad(i);
      i = escapeEnd(css, i);
      continue;
    }
    i += 1;
  }
  return { kind: "url", end: n, arg: css.slice(valueStart) };
}

function nextToken(css: string, i: number): Token {
  const ch = css[i];
  if (css.startsWith("/*", i)) {
    return { kind: "comment", end: commentEnd(css, i), arg: "" };
  }
  if (ch === '"' || ch === "'") return stringToken(css, i);
  if (isWs(ch)) {
    let end = i + 1;
    while (isWs(css[end])) end += 1;
    return { kind: "whitespace", end, arg: "" };
  }
  if (ch === "#" || ch === "@") {
    const end = identEnd(css, i + 1);
    if (end === i + 1) return { kind: "delim", end, arg: ch };
    return {
      kind: ch === "#" ? "hash" : "at-keyword",
      end,
      arg: cssUnescape(css.slice(i + 1, end)).toLowerCase(),
    };
  }
  if (isIdentChar(ch) || isValidEscape(css, i)) {
    const end = identEnd(css, i);
    const name = cssUnescape(css.slice(i, end)).toLowerCase();
    if (css[end] !== "(") return { kind: "ident", end, arg: name };
    if (name === "url") {
      let j = end + 1;
      while (isWs(css[j])) j += 1;
      if (css[j] !== '"' && css[j] !== "'") return urlToken(css, end + 1);
    }
    return { kind: "function", end: end + 1, arg: name };
  }
  return { kind: "delim", end: i + 1, arg: ch };
}

/** Index just past the `closer` ending the block whose contents start at `i`. */
function blockEnd(css: string, i: number, closer: string): number {
  const stack = [closer];
  const n = css.length;
  while (i < n) {
    const tok = nextToken(css, i);
    if (tok.kind === "function") {
      stack.push(")");
    } else if (tok.kind === "delim" && tok.arg in CLOSER) {
      stack.push(CLOSER[tok.arg]);
    } else if (tok.kind === "delim" && tok.arg === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return tok.end;
    }
    i = tok.end;
  }
  return n;
}

/** End of an at-rule prelude: just past `;`, or before `{` / `}`. */
function preludeEnd(css: string, i: number): number {
  const n = css.length;
  while (i < n) {
    const tok = nextToken(css, i);
    let end = tok.end;
    if (tok.kind === "delim" && tok.arg === ";") return end;
    if (tok.kind === "delim" && (tok.arg === "{" || tok.arg === "}")) return i;
    if (tok.kind === "function") {
      end = blockEnd(css, end, ")");
    } else if (tok.kind === "delim" && (tok.arg === "(" || tok.arg === "[")) {
      end = blockEnd(css, end, CLOSER[tok.arg]);
    }
    i = end;
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

/** Every URL an image function's arguments (`css[start, stop)`) name is allowed. */
function argumentsSafe(css: string, start: number, stop: number): boolean {
  let i = start;
  while (i < stop) {
    const tok = nextToken(css, i);
    if (tok.kind === "bad-url") return false;
    if (
      (tok.kind === "url" || tok.kind === "string") &&
      !cssUrlAllowed(tok.arg)
    ) {
      return false;
    }
    if (
      tok.kind === "function" &&
      (SUBSTITUTION_FUNCTIONS.has(tok.arg) || tok.arg.startsWith("--"))
    ) {
      return false;
    }
    i = tok.end;
  }
  return true;
}

/** Remove `@import` and any URL that is not `data:` or same-origin relative. */
export function stripRemoteCss(input: string): string {
  const css = preprocess(input);
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const tok = nextToken(css, i);
    let end = tok.end;
    if (tok.kind === "at-keyword" && tok.arg === "import") {
      end = preludeEnd(css, end);
    } else if (tok.kind === "url" || tok.kind === "bad-url") {
      const keep = tok.kind === "url" && cssUrlAllowed(tok.arg);
      out += keep ? css.slice(i, end) : "none";
    } else if (tok.kind === "function" && URL_FUNCTIONS.has(tok.arg)) {
      const close = blockEnd(css, end, ")");
      out += argumentsSafe(css, end, close) ? css.slice(i, close) : "none";
      end = close;
    } else {
      out += css.slice(i, end);
    }
    i = end;
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
