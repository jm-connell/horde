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
    meaning: "Translucent panel fill (when enabled)",
  },
  { selector: "--ui-panel-blur", meaning: "Translucent panel blur" },
];

export const CSS_SELECTORS: CssHookRow[] = [
  {
    selector: "html[data-theme]",
    meaning: "Active palette: oled, light, custom, …",
  },
  {
    selector: 'html[data-page="home"]',
    meaning: "Library home. Also: watch, settings, history, download, import, playlists, playlist",
  },
  { selector: '[data-horde="nav"]', meaning: "Top navigation bar" },
  { selector: '[data-horde="main"]', meaning: "Page content shell" },
  { selector: '[data-horde="sidebar"]', meaning: "Library channel sidebar rail" },
  { selector: '[data-horde="channel-list"]', meaning: "Channel list inside the sidebar" },
  { selector: '[data-horde="background"]', meaning: "Background effect / image" },
  { selector: '[data-horde="video-card"]', meaning: "Library video card" },
  { selector: '[data-horde="feed-card"]', meaning: "Channel feed card" },
  { selector: ".page-shell", meaning: "Centered page column" },
  { selector: ".ui-panel", meaning: "Settings panels, menus, chrome blocks" },
  { selector: ".ui-card", meaning: "Hoverable cards (library, playlists)" },
  { selector: ".ui-interactive", meaning: "Buttons and clickable chrome" },
  { selector: ".horde-scrollbar", meaning: "Themed overlay scroll areas" },
];

const PAGE_IDS = [
  "home",
  "watch",
  "settings",
  "history",
  "download",
  "import",
  "playlists",
  "playlist",
] as const;

export type PageId = (typeof PAGE_IDS)[number] | "other";

export function pageIdFromPath(pathname: string): PageId {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/watch")) return "watch";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/playlists/")) return "playlist";
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

/**
 * Neutralize sequences that could break out of a <style> tag if the CSS is
 * ever assigned via HTML instead of textContent.
 */
export function sanitizeCustomCss(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

export function applyCustomCss(css: string): void {
  if (typeof document === "undefined") return;
  const next = sanitizeCustomCss(normalizeCustomCss(css));
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
