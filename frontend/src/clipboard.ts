function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?)]+$/, "");
}

/** First URL (or first line) from a clipboard paste. */
export function clipboardTextToUrl(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
  if (/^https?:\/\//i.test(firstLine)) {
    return stripTrailingUrlPunctuation(firstLine.split(/\s+/, 1)[0]!);
  }
  const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return firstLine;
  return stripTrailingUrlPunctuation(match[0]);
}

function urlFromChunk(part: string): string {
  const trimmed = part.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return stripTrailingUrlPunctuation(trimmed.split(/\s+/, 1)[0]!);
  }
  const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  return match ? stripTrailingUrlPunctuation(match[0]) : "";
}

/** Comma-separated download paste. Keeps the full list, unlike clipboardTextToUrl. */
export function parseDownloadUrlList(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const url = urlFromChunk(part);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (urls.length > 0) return urls;
  const fallback = clipboardTextToUrl(trimmed);
  return fallback ? [fallback] : [];
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function isYoutubeShortsUrl(url: string): boolean {
  return /\/shorts\//i.test(url);
}

/** Playlist page with no watch video id — skip these inside a bulk list. */
export function isYoutubePlaylistOnlyUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    const path = parsed.pathname;
    if (parsed.hostname.toLowerCase() === "youtu.be" && path.split("/")[1]) {
      return false;
    }
    if (parsed.searchParams.get("v")) return false;
    for (const prefix of ["/shorts/", "/embed/", "/live/", "/v/"]) {
      if (path.startsWith(prefix) && path.slice(prefix.length).split("/")[0]) {
        return false;
      }
    }
    const normalized = path.replace(/\/+$/, "") || "/";
    if (normalized === "/playlist" || normalized.startsWith("/playlist/")) {
      return true;
    }
    return parsed.searchParams.has("list");
  } catch {
    return false;
  }
}

function hrefFromHtml(html: string): string {
  const href = html.match(/href=["'](https?:\/\/[^"']+)["']/i);
  return href?.[1] ?? "";
}

export function clipboardEventToText(
  data: { getData: (type: string) => string } | null | undefined
): string {
  if (!data) return "";
  const plain = data.getData("text/plain") || data.getData("text/uri-list");
  if (plain?.trim()) return plain;
  return hrefFromHtml(data.getData("text/html") ?? "");
}

/**
 * True when this origin can attempt a programmatic clipboard read.
 * False on plain HTTP LAN (typical live Horde) — localhost/HTTPS only.
 */
export function clipboardReadAvailable(
  nav: { clipboard?: { readText?: unknown; read?: unknown } } | undefined =
    typeof navigator === "undefined" ? undefined : navigator
): boolean {
  const clipboard = nav?.clipboard;
  if (!clipboard) return false;
  return (
    typeof clipboard.readText === "function" ||
    typeof clipboard.read === "function"
  );
}

/** Read clipboard text. Returns "" when the API is missing, denied, or empty. */
export async function readClipboardText(): Promise<string> {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return "";

  let denied = false;
  try {
    if (typeof clipboard.readText === "function") {
      const text = await clipboard.readText();
      if (text?.trim()) return text;
    }
  } catch {
    denied = true;
  }
  if (denied) return "";

  try {
    if (typeof clipboard.read !== "function") return "";
    const items = await clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/plain")) {
        const raw = await (await item.getType("text/plain")).text();
        if (raw.trim()) return raw;
      }
      if (item.types.includes("text/uri-list")) {
        const raw = await (await item.getType("text/uri-list")).text();
        if (raw.trim()) return raw;
      }
      if (item.types.includes("text/html")) {
        const raw = await (await item.getType("text/html")).text();
        const href = hrefFromHtml(raw);
        if (href) return href;
      }
    }
  } catch {
    return "";
  }
  return "";
}

/**
 * Page-level paste should fill the URL field unless the user is typing in
 * another field (or the URL input itself, which already handles native paste).
 */
export function shouldCapturePagePaste(
  target: unknown,
  urlInput: unknown
): boolean {
  if (target && target === urlInput) return false;
  if (!target || typeof target !== "object") return true;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT" && target !== urlInput) return false;
  if (tag === "TEXTAREA") return false;
  if (el.isContentEditable) return false;
  return true;
}

export function execPasteInto(
  el: { focus: () => void; select?: () => void } | null,
  execCommand: (command: string) => boolean = (command) =>
    typeof document !== "undefined" && document.execCommand(command)
): boolean {
  if (!el) return false;
  el.focus();
  el.select?.();
  try {
    return execCommand("paste");
  } catch {
    return false;
  }
}

/**
 * Paste-button click. On HTTP LAN `navigator.clipboard` is missing; we must
 * run execPaste in the same turn as the click. Awaiting the Clipboard API
 * first drops user activation and is why live deploys broke while localhost
 * (a secure context) still worked.
 */
export async function pasteTextFromButtonClick(hooks: {
  clipboardReadAvailable: boolean;
  readClipboard: () => Promise<string>;
  execPaste: () => boolean;
}): Promise<string> {
  if (!hooks.clipboardReadAvailable) {
    hooks.execPaste();
    return "";
  }
  return (await hooks.readClipboard()) ?? "";
}
