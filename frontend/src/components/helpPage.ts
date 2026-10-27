const PAGES: [prefix: string, label: string][] = [
  ["/watch", "Watch page"],
  ["/history", "History"],
  ["/offline", "Offline downloads"],
  ["/download", "Download page"],
  ["/playlists", "Playlists"],
  ["/import", "Import page"],
  ["/settings", "Settings"],
  ["/account", "Account settings"],
];

/** Longest path (with query) sent; the label carries the meaning. */
const MAX_PATH = 100;

/**
 * One line telling Ask about Horde where the user is, e.g.
 * `Settings, AI tab (/settings)`. Sent with each question so "this
 * page" and vague questions have something to go on.
 */
export function describePage(
  pathname: string,
  search: string,
  extra: {
    /** What part of the page is showing, e.g. "AI tab". */
    detail?: string;
    /** The library search box's committed query. */
    query?: string;
    playing?: { title: string; mini: boolean } | null;
  } = {}
): string {
  let label =
    pathname === "/"
      ? "Library"
      : (PAGES.find(
          ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
        )?.[1] ?? "an unknown page");
  const detail = extra.detail?.trim();
  if (detail) label += `, ${detail.slice(0, 40)}`;
  const query = extra.query?.trim();
  if (query && pathname === "/") label += `, searching "${query.slice(0, 60)}"`;
  const playing = extra.playing;
  if (playing?.title) {
    const title = playing.title.slice(0, 80);
    label += playing.mini
      ? `, with "${title}" in the mini player`
      : `, watching "${title}"`;
  }
  // At most 300 characters, the server's limit.
  return `${label.slice(0, 300 - MAX_PATH - 3)} (${(pathname + search).slice(0, MAX_PATH)})`;
}
