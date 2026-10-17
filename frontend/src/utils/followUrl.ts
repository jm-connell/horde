const TAB_SUFFIXES = new Set([
  "videos",
  "streams",
  "shorts",
  "live",
  "playlists",
  "featured",
  "about",
  "search",
]);

/**
 * Mirror of the server's channel URL normalisation, so a library channel's
 * `channel_url` can be compared with a follow's `channel_url` (keep the two in
 * step with `normalize_channel_url` in backend/app/services/follows.py): https,
 * lowercase host without `www.` / `m.` or a port, no query, no trailing slash
 * or tab suffix in any case, lowercase `@handle`. Null when not a URL.
 */
export function normalizeChannelUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
    );
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (!host) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  while (
    parts.length > 1 &&
    TAB_SUFFIXES.has(parts[parts.length - 1].toLowerCase())
  ) {
    parts.pop();
  }
  const path = parts
    .map((p) => (p.startsWith("@") ? p.toLowerCase() : p))
    .join("/");
  return `https://${host}${path ? `/${path}` : ""}`;
}

export function isYoutubeChannelUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const norm = normalizeChannelUrl(raw);
  if (!norm) return false;
  const host = new URL(norm).hostname;
  return host === "youtube.com" || host.endsWith(".youtube.com");
}

/** "1.2K watching", or null when the count is unknown. */
export function formatViewers(
  viewers: number | null | undefined
): string | null {
  if (viewers == null || viewers < 0) return null;
  const n = viewers;
  const body =
    n >= 1_000_000
      ? `${Math.round(n / 100_000) / 10}M`
      : n >= 1_000
        ? `${Math.round(n / 100) / 10}K`
        : String(n);
  return `${body} watching`;
}
